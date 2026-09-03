import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { purgeGuild, forgetUser, describeUserData } from '../src/db/purge.js';

const G = '111111111111111111';
const OTHER = '222222222222222222';
const U = '333333333333333333';

function seed(guildId, userId) {
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO guild_settings (guild_id, modlog_channel_id, updated_at) VALUES (?,?,?)'
  ).run(guildId, '9', now);
  db.prepare(
    'INSERT OR REPLACE INTO guild_modules (guild_id, module_id, enabled, config, updated_at) VALUES (?,?,?,?,?)'
  ).run(guildId, 'leveling', 1, '{}', now);
  db.prepare(
    'INSERT INTO infractions (guild_id, case_number, user_id, moderator_id, action, reason, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(guildId, 1, userId, 'mod', 'warn', 'x', now);
  db.prepare(
    'INSERT OR REPLACE INTO leveling (guild_id, user_id, xp, level, messages, last_msg_at) VALUES (?,?,?,?,?,?)'
  ).run(guildId, userId, 500, 3, 20, now);
  db.prepare(
    'INSERT OR REPLACE INTO counting (guild_id, current, record, last_user_id, last_message_id, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(guildId, 5, 9, userId, 'm', now);
  const t = db
    .prepare('INSERT INTO tickets (guild_id, user_id, status, created_at, last_at) VALUES (?,?,?,?,?)')
    .run(guildId, userId, 'open', now, now);
  db.prepare(
    'INSERT INTO ticket_messages (ticket_id, author_id, author_kind, content, created_at) VALUES (?,?,?,?,?)'
  ).run(t.lastInsertRowid, userId, 'user', 'hi', now);
  db.prepare(
    'INSERT INTO scheduled_messages (guild_id, channel_id, content, interval_minutes, next_run_at, created_at) VALUES (?,?,?,?,?,?)'
  ).run(guildId, '9', 'x', 60, now, now);
  db.prepare('INSERT INTO config_audit (guild_id, actor, action, detail, created_at) VALUES (?,?,?,?,?)').run(
    guildId,
    'a',
    'x',
    '',
    now
  );
  db.prepare('INSERT OR REPLACE INTO afk (guild_id, user_id, reason, since) VALUES (?,?,?,?)').run(
    guildId,
    userId,
    'brb',
    now
  );
  db.prepare(
    'INSERT OR REPLACE INTO birthdays (guild_id, user_id, month, day, year, created_at) VALUES (?,?,?,?,?,?)'
  ).run(guildId, userId, 6, 15, null, now);
  const g = db
    .prepare(
      'INSERT INTO giveaways (guild_id, channel_id, prize, host_id, ends_at, created_at) VALUES (?,?,?,?,?,?)'
    )
    .run(guildId, '9', 'nitro', userId, now + 1000, now);
  db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?,?,?)').run(
    g.lastInsertRowid,
    userId,
    now
  );
}

const countFor = (table, guildId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id = ?`).get(guildId).n;

test('purgeGuild removes every guild-scoped row and leaves other guilds alone', () => {
  seed(G, U);
  seed(OTHER, U);

  purgeGuild(G);

  for (const t of [
    'guild_settings',
    'guild_modules',
    'infractions',
    'leveling',
    'counting',
    'tickets',
    'scheduled_messages',
    'config_audit',
    'afk',
    'birthdays',
    'giveaways',
  ]) {
    assert.equal(countFor(t, G), 0, `${t} should be empty for purged guild`);
  }
  for (const [table, sub] of [
    ['ticket_messages', 'tickets'],
    ['giveaway_entries', 'giveaways'],
  ]) {
    assert.equal(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'ticket_messages' ? 'ticket_id' : 'giveaway_id'} IN (SELECT id FROM ${sub} WHERE guild_id = ?)`
        )
        .get(G).n,
      0,
      `${table} should be gone`
    );
  }
  assert.equal(countFor('leveling', OTHER), 1, 'other guild untouched');
  assert.equal(countFor('afk', OTHER), 1, 'other guild afk untouched');
});

test('forgetUser deletes only that member’s data in that guild', () => {
  db.exec(
    'DELETE FROM leveling; DELETE FROM infractions; DELETE FROM tickets; DELETE FROM ticket_messages; DELETE FROM counting; DELETE FROM afk; DELETE FROM birthdays; DELETE FROM giveaways; DELETE FROM giveaway_entries;'
  );
  seed(G, U);
  const KEEP = '444444444444444444';
  db.prepare(
    'INSERT OR REPLACE INTO leveling (guild_id, user_id, xp, level, messages, last_msg_at) VALUES (?,?,?,?,?,?)'
  ).run(G, KEEP, 10, 0, 1, Date.now());
  db.prepare('INSERT OR REPLACE INTO afk (guild_id, user_id, reason, since) VALUES (?,?,?,?)').run(
    G,
    KEEP,
    'x',
    Date.now()
  );
  const gid = db.prepare('SELECT id FROM giveaways WHERE guild_id = ?').get(G).id;
  db.prepare('INSERT INTO giveaway_entries (giveaway_id, user_id, entered_at) VALUES (?,?,?)').run(
    gid,
    KEEP,
    Date.now()
  );

  const result = forgetUser(G, U);

  assert.equal(result.warnings, 1);
  assert.equal(result.leveling, 1);
  assert.equal(result.tickets, 1);
  assert.equal(result.ticketMessages, 1);
  assert.equal(result.afk, 1);
  assert.equal(result.birthdays, 1);
  assert.equal(result.giveawayEntries, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM leveling WHERE guild_id = ?').get(G).n,
    1,
    'other member kept'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM afk WHERE guild_id = ?').get(G).n,
    1,
    'other member afk kept'
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries').get().n,
    1,
    'other member giveaway entry kept'
  );
  assert.equal(
    db.prepare('SELECT last_user_id FROM counting WHERE guild_id = ?').get(G).last_user_id,
    null,
    'counting lock cleared'
  );
});

test('describeUserData counts what forgetUser would remove, then reads zero after', () => {
  db.exec(
    'DELETE FROM leveling; DELETE FROM infractions; DELETE FROM tickets; DELETE FROM ticket_messages; DELETE FROM counting; DELETE FROM afk; DELETE FROM birthdays; DELETE FROM giveaways; DELETE FROM giveaway_entries;'
  );
  seed(G, U);

  const before = describeUserData(G, U);
  const byKey = Object.fromEntries(before.items.map((i) => [i.key, i.count]));
  assert.equal(byKey.warnings, 1);
  assert.equal(byKey.leveling, 1);
  assert.equal(byKey.tickets, 1);
  assert.equal(byKey.ticketMessages, 1);
  assert.equal(byKey.afk, 1);
  assert.equal(byKey.birthdays, 1);
  assert.equal(byKey.giveawayEntries, 1);
  assert.equal(byKey.countingLast, 1);
  assert.ok(before.total >= 8);

  forgetUser(G, U);

  assert.equal(describeUserData(G, U).total, 0, 'nothing left after forgetUser');
});
