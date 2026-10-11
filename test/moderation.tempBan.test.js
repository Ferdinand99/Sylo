import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RESTJSONErrorCodes } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { settleTempBan } from '../src/modules/moderation.js';
import { scheduleTempBan, getTempBan } from '../src/db/tempBans.js';

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
