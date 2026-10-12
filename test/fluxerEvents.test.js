import test from 'node:test';
import assert from 'node:assert/strict';
import { fluxerReactionAdd } from '../src/platform/fluxerEvents.js';

const GUILD = '900000000000000099';

function world({ cachedMessage = true, guildId = null } = {}) {
  const calls = { removed: [], fetched: 0 };
  const guild = { id: GUILD };
  const message = {
    id: 'm1',
    channelId: 'c1',
    guildId,
    removeReaction: async (emoji, userId) => {
      calls.removed.push([emoji, userId]);
    },
  };
  const channel = { id: 'c1', guildId: GUILD };
  const client = {
    guilds: { cache: new Map([[GUILD, guild]]) },
    channels: { cache: new Map([['c1', channel]]) },
    users: {
      fetch: async (id) => {
        calls.fetched += 1;
        return { id, bot: false };
      },
    },
  };
  const payload = {
    reaction: {
      emoji: { name: '🎉' },
      fetchMessage: async () => message,
    },
    message: cachedMessage ? message : null,
    channel,
    channelId: 'c1',
    messageId: 'm1',
    emoji: { name: '🎉' },
    userId: 'u1',
    user: { id: 'u1', bot: false },
  };
  return { client, payload, message, calls, guild };
}

test('a Fluxer reaction payload becomes the (reaction, user) pair the bridge expects', async () => {
  const { client, payload, message } = world();
  const { reaction, user } = await fluxerReactionAdd(client, payload);
  assert.equal(user.id, 'u1');
  assert.equal(reaction.emoji.name, '🎉');
  assert.equal(reaction.message, message);
});

test('a message the bot sent itself (no guild id) is given its guild from the channel', async () => {
  const { client, payload, guild } = world({ guildId: null });
  const { reaction } = await fluxerReactionAdd(client, payload);
  assert.equal(reaction.message.guildId, GUILD);
  assert.equal(reaction.message.guild, guild);
});

test('an uncached message is fetched', async () => {
  const { client, payload, message } = world({ cachedMessage: false });
  payload.reaction.message = null;
  const { reaction } = await fluxerReactionAdd(client, payload);
  assert.equal(reaction.message, message);
});

test('a missing user object is fetched by id', async () => {
  const { client, payload, calls } = world();
  delete payload.user;
  const { user } = await fluxerReactionAdd(client, payload);
  assert.equal(user.id, 'u1');
  assert.equal(calls.fetched, 1);
});

test("reaction.users.remove() removes that user's reaction through the message", async () => {
  const { client, payload, calls } = world();
  const { reaction } = await fluxerReactionAdd(client, payload);
  await reaction.users.remove('u1');
  assert.deepEqual(calls.removed, [['🎉', 'u1']]);
});

test('an unreadable message gives null instead of throwing', async () => {
  const { client, payload } = world({ cachedMessage: false });
  payload.reaction.message = null;
  payload.reaction.fetchMessage = async () => {
    throw new Error('MESSAGE_NOT_FOUND');
  };
  assert.equal(await fluxerReactionAdd(client, payload), null);
});

test("the bot's own reactions are not events worth handling", async () => {
  const { client, payload } = world();
  client.user = { id: 'u1' };
  assert.equal(await fluxerReactionAdd(client, payload), null);
});
