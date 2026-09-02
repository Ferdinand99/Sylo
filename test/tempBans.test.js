import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduleTempBan,
  getTempBan,
  clearTempBan,
  guildTempBans,
  dueTempBans,
  clearGuildTempBans,
} from '../src/db/tempBans.js';

const G1 = '900000000000000001';
const G2 = '900000000000000002';
const U1 = '800000000000000001';
const U2 = '800000000000000002';

test('scheduleTempBan then getTempBan round-trips', () => {
  const unbanAt = Date.now() + 3_600_000;
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod1', reason: 'spam', unbanAt });

  const row = getTempBan(G1, U1);
  assert.equal(row.guild_id, G1);
  assert.equal(row.user_id, U1);
  assert.equal(row.mod_id, 'mod1');
  assert.equal(row.reason, 'spam');
  assert.equal(row.unban_at, unbanAt);
  assert.ok(row.created_at <= Date.now());
  assert.equal(getTempBan(G1, 'nobody'), null);
});

test('scheduleTempBan upserts — one row per (guild, user)', () => {
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod1', reason: 'first', unbanAt: 1 });
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'mod2', reason: 'second', unbanAt: 2 });

  const rows = guildTempBans(G1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'second');
  assert.equal(rows[0].mod_id, 'mod2');
  assert.equal(rows[0].unban_at, 2);
});

test('dueTempBans returns only rows whose unban_at has passed', () => {
  clearGuildTempBans(G1);
  const now = Date.now();
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'm', reason: 'past', unbanAt: now - 1000 });
  scheduleTempBan({ guildId: G1, userId: U2, modId: 'm', reason: 'future', unbanAt: now + 60_000 });

  const due = dueTempBans(now);
  assert.deepEqual(
    due.map((r) => r.user_id),
    [U1]
  );
});

test('guildTempBans is ordered by unban_at ascending and scoped to the guild', () => {
  clearGuildTempBans(G1);
  clearGuildTempBans(G2);
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'm', reason: 'later', unbanAt: 5000 });
  scheduleTempBan({ guildId: G1, userId: U2, modId: 'm', reason: 'sooner', unbanAt: 1000 });
  scheduleTempBan({ guildId: G2, userId: U1, modId: 'm', reason: 'other guild', unbanAt: 1 });

  assert.deepEqual(
    guildTempBans(G1).map((r) => r.user_id),
    [U2, U1]
  );
  assert.equal(guildTempBans(G2).length, 1);
});

test('clearTempBan removes one row and reports the change count', () => {
  clearGuildTempBans(G1);
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'm', reason: 'x', unbanAt: 1 });

  assert.equal(clearTempBan(G1, U1), 1);
  assert.equal(clearTempBan(G1, U1), 0);
  assert.equal(getTempBan(G1, U1), null);
});

test('clearGuildTempBans wipes a guild without touching others', () => {
  clearGuildTempBans(G1);
  clearGuildTempBans(G2);
  scheduleTempBan({ guildId: G1, userId: U1, modId: 'm', reason: 'x', unbanAt: 1 });
  scheduleTempBan({ guildId: G2, userId: U1, modId: 'm', reason: 'x', unbanAt: 1 });

  clearGuildTempBans(G1);
  assert.equal(guildTempBans(G1).length, 0);
  assert.equal(guildTempBans(G2).length, 1);
});
