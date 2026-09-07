import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import {
  addXp,
  getMember,
  topMembers,
  topMembersForPeriod,
  memberCountForPeriod,
  periodKeys,
  isoWeek,
  prunePeriods,
} from '../src/db/leveling.js';

const G = '900000000000000010';
const U1 = '900000000000000011';
const U2 = '900000000000000012';

test('isoWeek / periodKeys: shape and a known date', () => {
  // 2026-09-03 is a Thursday in ISO week 36.
  assert.equal(isoWeek(Date.parse('2026-09-03T12:00:00Z')), '2026-W36');
  const k = periodKeys(Date.parse('2026-09-03T12:00:00Z'));
  assert.deepEqual(k, { week: 'w:2026-W36', month: 'm:2026-09' });
  // 2027-01-01 (Friday) still belongs to ISO week 53 of 2026.
  assert.equal(isoWeek(Date.parse('2027-01-01T00:00:00Z')), '2026-W53');
});

test('addXp: writes the all-time row and both period rows; voice XP is broken out', async () => {
  const now = Date.parse('2026-09-03T12:00:00Z');
  await addXp(G, U1, 100, now); // text
  await addXp(G, U1, 40, now, { voice: true, minutes: 8 }); // voice

  const m = await getMember(G, U1);
  assert.equal(m.xp, 140);
  assert.equal(m.messages, 1); // voice award doesn't bump messages
  assert.equal(m.voice_xp, 40);
  assert.equal(m.voice_minutes, 8);

  const { week, month } = periodKeys(now);
  const w = db
    .prepare('SELECT * FROM leveling_periods WHERE guild_id = ? AND user_id = ? AND period = ?')
    .get(G, U1, week);
  assert.equal(w.xp, 140);
  assert.equal(w.voice_xp, 40);
  assert.equal(w.messages, 1);
  const mo = db
    .prepare('SELECT xp FROM leveling_periods WHERE guild_id = ? AND user_id = ? AND period = ?')
    .get(G, U1, month);
  assert.equal(mo.xp, 140);
});

test("addXp: leveledUp/previousLevel reflect just this call's own delta", async () => {
  const g = '900000000000000013';
  const now = Date.parse('2026-09-03T12:00:00Z');
  const first = await addXp(g, U1, 50, now); // 0 -> level 0, no level up yet
  assert.equal(first.leveledUp, false);
  assert.equal(first.previousLevel, 0);

  const second = await addXp(g, U1, 100, now); // enough to cross into level 1
  assert.equal(second.xp, 150);
  assert.ok(second.level >= 1);
  assert.equal(second.leveledUp, true);
  assert.equal(second.previousLevel, 0);
});

test('topMembersForPeriod: ranks by that period only, ignores other periods', async () => {
  const thisWeek = Date.parse('2026-09-03T12:00:00Z');
  const lastMonth = Date.parse('2026-08-10T12:00:00Z');
  await addXp(G, U2, 500, lastMonth); // only in August's rows
  await addXp(G, U2, 10, thisWeek);

  const { week } = periodKeys(thisWeek);
  const rows = await topMembersForPeriod(G, week, 10);
  // This week: U1 has 140, U2 has 10.
  assert.deepEqual(
    rows.map((r) => r.user_id),
    [U1, U2]
  );
  assert.equal(await memberCountForPeriod(G, week), 2);

  // All-time still has U2 ahead (510 vs 140).
  assert.equal((await topMembers(G, 2))[0].user_id, U2);
});

test('prunePeriods: drops weeks/months older than the retention window', async () => {
  db.prepare('INSERT OR REPLACE INTO leveling_periods (guild_id, user_id, period, xp) VALUES (?,?,?,?)').run(
    G,
    U1,
    'w:2020-W01',
    5
  );
  db.prepare('INSERT OR REPLACE INTO leveling_periods (guild_id, user_id, period, xp) VALUES (?,?,?,?)').run(
    G,
    U1,
    'm:2020-01',
    5
  );
  await prunePeriods(10, 6, Date.parse('2026-09-03T12:00:00Z'));
  assert.equal(db.prepare("SELECT 1 FROM leveling_periods WHERE period = 'w:2020-W01'").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM leveling_periods WHERE period = 'm:2020-01'").get(), undefined);
  // Recent rows survive.
  assert.ok(db.prepare("SELECT 1 FROM leveling_periods WHERE period = 'w:2026-W36'").get());
});
