import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTJSONErrorCodes } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { settleTempBan } from '../src/modules/moderation.js';
import { scheduleTempBan, getTempBan } from '../src/db/tempBans.js';
import { addCase } from '../src/db/modCases.js';
import { EventEmitter } from 'node:events';
import { register } from '../src/bot/events/moduleEvents.js';

const GUILD_ID = '900000000000000010';

function mockGuild({ banned = true, removeImpl } = {}) {
  return {
    id: GUILD_ID,
    members: { me: { permissions: { has: () => true } } },
    bans: {
      fetch: async () => (banned ? { user: { id: 'x' } } : null),
      remove: removeImpl ?? (async () => {}),
    },
  };
}

async function scheduleRow(userId) {
  await scheduleTempBan({
    guildId: GUILD_ID,
    userId,
    modId: 'tester',
    reason: 'test',
    unbanAt: Date.now() - 1000,
  });
}

test('settleTempBan: a successful unban clears the row', async () => {
  await scheduleRow('1');
  runtime.client = { guilds: { cache: new Map([[GUILD_ID, mockGuild()]]) } };

  await settleTempBan({
    guild_id: GUILD_ID,
    user_id: '1',
    reason: 'r',
    created_at: Date.now() - 2000,
    unban_at: Date.now(),
  });

  assert.equal(await getTempBan(GUILD_ID, '1'), null);
});

test('settleTempBan: already-gone (manual unban) clears the row without throwing', async () => {
  await scheduleRow('2');
  runtime.client = { guilds: { cache: new Map([[GUILD_ID, mockGuild({ banned: false })]]) } };

  await settleTempBan({
    guild_id: GUILD_ID,
    user_id: '2',
    reason: 'r',
    created_at: Date.now() - 2000,
    unban_at: Date.now(),
  });

  assert.equal(await getTempBan(GUILD_ID, '2'), null);
});

test('settleTempBan: Discord UnknownBan during remove() still clears the row', async () => {
  await scheduleRow('3');
  const err = Object.assign(new Error('Unknown Ban'), { code: RESTJSONErrorCodes.UnknownBan });
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          GUILD_ID,
          mockGuild({
            removeImpl: async () => {
              throw err;
            },
          }),
        ],
      ]),
    },
  };

  await settleTempBan({
    guild_id: GUILD_ID,
    user_id: '3',
    reason: 'r',
    created_at: Date.now() - 2000,
    unban_at: Date.now(),
  });

  assert.equal(await getTempBan(GUILD_ID, '3'), null);
});

test('settleTempBan: a transient remove() failure leaves the row for the next retry', async () => {
  await scheduleRow('4');
  const err = Object.assign(new Error('rate limited'), { code: 50013 });
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          GUILD_ID,
          mockGuild({
            removeImpl: async () => {
              throw err;
            },
          }),
        ],
      ]),
    },
  };

  await assert.rejects(
    settleTempBan({
      guild_id: GUILD_ID,
      user_id: '4',
      reason: 'r',
      created_at: Date.now() - 2000,
      unban_at: Date.now(),
    })
  );

  assert.notEqual(await getTempBan(GUILD_ID, '4'), null);
});

test('settleTempBan: no BanMembers permission leaves the row for the next retry', async () => {
  await scheduleRow('5');
  const guild = mockGuild();
  guild.members.me.permissions.has = () => false;
  runtime.client = { guilds: { cache: new Map([[GUILD_ID, guild]]) } };

  await settleTempBan({
    guild_id: GUILD_ID,
    user_id: '5',
    reason: 'r',
    created_at: Date.now() - 2000,
    unban_at: Date.now(),
  });

  assert.notEqual(await getTempBan(GUILD_ID, '5'), null);
});

// A temporary ban lifted outside Sylo leaves its row behind. The member is then banned again for good
// (warn threshold, automod, honeypot, another bot) and the stale timer must not lift that ban.
test('settleTempBan: a later permanent ban the timer was not set for stays, and the row is dropped', async () => {
  await scheduleRow('6');
  const row = await getTempBan(GUILD_ID, '6');
  let removed = 0;
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          GUILD_ID,
          mockGuild({
            removeImpl: async () => {
              removed += 1;
            },
          }),
        ],
      ]),
    },
  };
  await new Promise((r) => setTimeout(r, 5));
  // The permanent ban, as the warn-threshold auto-ban records it: no duration.
  await addCase({ guildId: GUILD_ID, userId: '6', moderatorId: 'auto', action: 'ban', reason: 'warnings' });

  await settleTempBan({ ...row, unban_at: Date.now() - 1 });

  assert.equal(removed, 0, 'still banned');
  assert.equal(await getTempBan(GUILD_ID, '6'), null);
});

test('settleTempBan: the timed ban’s own case does not stop it being lifted', async () => {
  await scheduleRow('7');
  const row = await getTempBan(GUILD_ID, '7');
  let removed = 0;
  runtime.client = {
    guilds: {
      cache: new Map([
        [
          GUILD_ID,
          mockGuild({
            removeImpl: async () => {
              removed += 1;
            },
          }),
        ],
      ]),
    },
  };
  await new Promise((r) => setTimeout(r, 5));
  await addCase({
    guildId: GUILD_ID,
    userId: '7',
    moderatorId: 'tester',
    action: 'ban',
    reason: 'r',
    detail: '1 day',
  });

  await settleTempBan({ ...row, unban_at: Date.now() - 1 });

  assert.equal(removed, 1);
  assert.equal(await getTempBan(GUILD_ID, '7'), null);
});

test('a lifted ban ends the temporary-ban timer even when no module handles the event', async () => {
  await scheduleRow('8');
  const client = new EventEmitter();
  register(client);
  const guild = { id: GUILD_ID, client: runtime.client };
  client.emit('guildBanRemove', { guild, user: { id: '8' } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await getTempBan(GUILD_ID, '8'), null);
});
