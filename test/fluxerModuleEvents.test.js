import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerFluxerModuleEvents } from '../src/bot/fluxerModuleEvents.js';

const RAW = '900000000000000060';
const KEY = `fluxer:${RAW}`;
const BOT = '555555555555555555';

function setup() {
  const calls = [];
  const purged = [];
  const client = new EventEmitter();
  client.user = { id: BOT };
  client.channels = new Map([['c1', { id: 'c1', guildId: RAW }]]);
  client.users = { fetch: async (id) => ({ id, username: `user-${id}` }) };
  client.guilds = { cache: new Map() };
  registerFluxerModuleEvents(client, {
    dispatch: async (event, key, payload) => calls.push({ event, key, payload }),
    purge: async (key) => purged.push(key),
  });
  const fire = async (event, ...args) => {
    client.emit(event, ...args);
    await new Promise((r) => setImmediate(r));
  };
  return { client, calls, fire, purged };
}

test('member add / update / remove are keyed by the fluxer guild key', async () => {
  const { calls, fire } = setup();
  const member = { id: 'u1', guild: { id: RAW }, user: { id: 'u1', username: 'a' } };
  await fire('guildMemberAdd', member);
  await fire('guildMemberRemove', member);
  await fire('guildMemberUpdate', null, member);
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['guildMemberAdd', KEY],
      ['guildMemberRemove', KEY],
      ['guildMemberUpdate', KEY],
    ]
  );
  assert.deepEqual(calls[2].payload, { old: member, new: member }); // no previous state: old = new
});

test('a leaving member the SDK only knows by id gets a full user', async () => {
  const { calls, fire } = setup();
  await fire('guildMemberRemove', { id: 'u9', guild: { id: RAW }, user: { id: 'u9' } });
  assert.equal(calls[0].payload.user.username, 'user-u9');
});

test('ban add / remove use the ban guild id', async () => {
  const { calls, fire } = setup();
  await fire('guildBanAdd', { guildId: RAW, user: { id: 'u2' } });
  await fire('guildBanRemove', { guildId: RAW, user: { id: 'u2' } });
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['guildBanAdd', KEY],
      ['guildBanRemove', KEY],
    ]
  );
});

test('messageCreate: humans reach messageCreate and messageCreateAny, bots only messageCreateAny, DMs neither', async () => {
  const { calls, fire } = setup();
  await fire('messageCreate', { guildId: RAW, author: { id: 'u1', bot: false } });
  await fire('messageCreate', { guildId: RAW, author: { id: 'b1', bot: true } });
  await fire('messageCreate', { guildId: null, author: { id: 'u1' } });
  assert.deepEqual(
    calls.map((c) => c.event),
    ['messageCreateAny', 'messageCreate', 'messageCreateAny']
  );
  assert.ok(calls.every((c) => c.key === KEY));
});

test('message update and delete are keyed, a delete without a guild is ignored', async () => {
  const { calls, fire } = setup();
  await fire('messageUpdate', { id: 'm' }, { id: 'm', guildId: RAW });
  await fire('messageDelete', { id: 'm', guildId: RAW });
  await fire('messageDelete', { id: 'm', guildId: null });
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['messageUpdate', KEY],
      ['messageDelete', KEY],
    ]
  );
});

test('bulk delete becomes a Map of partial messages plus the channel', async () => {
  const { calls, fire } = setup();
  await fire('messageDeleteBulk', { ids: ['a', 'b'], channelId: 'c1', guildId: RAW });
  const { messages, channel } = calls[0].payload;
  assert.equal(calls[0].key, KEY);
  assert.deepEqual([...messages.keys()], ['a', 'b']);
  assert.equal(channel.id, 'c1');
});

test('role create / delete: a delete the SDK has no role object for still carries id and guild', async () => {
  const { calls, fire } = setup();
  await fire('guildRoleCreate', { id: 'r1', guildId: RAW });
  await fire('guildRoleDelete', null, RAW, 'r2');
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['roleCreate', KEY],
      ['roleDelete', KEY],
    ]
  );
  assert.deepEqual(calls[1].payload, { id: 'r2', guildId: RAW, name: null });
});

test('invites and channels are keyed', async () => {
  const { calls, fire } = setup();
  await fire('inviteCreate', { guildSnapshot: { id: RAW } });
  await fire('inviteDelete', { guildId: RAW, code: 'x' });
  await fire('channelCreate', { id: 'c', guildId: RAW });
  await fire('channelDelete', { id: 'c', guildId: RAW });
  await fire('channelCreate', { id: 'dm', guildId: null });
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['inviteCreate', KEY],
      ['inviteDelete', KEY],
      ['channelCreate', KEY],
      ['channelDelete', KEY],
    ]
  );
});

test('guildCreate carries the guild', async () => {
  const { calls, fire } = setup();
  const guild = { id: RAW };
  await fire('guildCreate', guild);
  assert.deepEqual(calls[0], { event: 'guildCreate', key: KEY, payload: guild });
});

test('reactions reach the modules as { reaction, user } with the message and its guild resolved', async () => {
  const { calls, fire, client } = setup();
  const message = { id: 'm1', channelId: 'c1', guildId: null };
  const payload = {
    reaction: { emoji: { name: '⭐' }, message },
    message,
    channel: client.channels.get('c1'),
    channelId: 'c1',
    emoji: { name: '⭐' },
    userId: 'u1',
    user: { id: 'u1', bot: false },
  };
  await fire('messageReactionAdd', payload);
  await fire('messageReactionRemove', payload);
  assert.deepEqual(
    calls.map((c) => [c.event, c.key]),
    [
      ['reactionAdd', KEY],
      ['reactionRemove', KEY],
    ]
  );
  assert.equal(calls[0].payload.user.id, 'u1');
  assert.equal(calls[0].payload.reaction.emoji.name, '⭐');
  assert.equal(calls[0].payload.reaction.message.guildId, RAW);
});

test("Sylo's own reactions are not forwarded to modules", async () => {
  const { calls, fire } = setup();
  await fire('messageReactionAdd', { userId: BOT, emoji: { name: '⭐' }, channelId: 'c1' });
  assert.equal(calls.length, 0);
});

test('a handler that throws does not break the event loop', async () => {
  const client = new EventEmitter();
  client.user = { id: BOT };
  client.channels = new Map();
  client.users = { fetch: async () => null };
  registerFluxerModuleEvents(client, {
    dispatch: async () => {
      throw new Error('boom');
    },
  });
  client.emit('guildCreate', { id: RAW });
  await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the run
});

test('removing Sylo from a guild purges that guild by its key, unless the guild is only unavailable', async () => {
  const { purged, fire } = setup();
  await fire('guildDelete', { id: RAW, name: 'Gone' });
  await fire('guildDelete', { id: '900000000000000061', available: false });
  assert.deepEqual(purged, [KEY]);
});

test('a command message reaches messageCreateAny and the moderation-only commandMessageCreate, not the chat modules', async () => {
  const calls = [];
  const client = new EventEmitter();
  client.user = { id: BOT };
  client.channels = new Map();
  client.users = { fetch: async () => null };
  registerFluxerModuleEvents(client, {
    dispatch: async (event, key, message) => calls.push([event, key, message.content]),
    isCommand: (m) => m.content.startsWith('!'),
  });
  client.emit('messageCreate', { guildId: RAW, content: '!afk lunsj', author: { id: 'u1', bot: false } });
  client.emit('messageCreate', { guildId: RAW, content: 'hello', author: { id: 'u1', bot: false } });
  await new Promise((r) => setImmediate(r));
  // The two messages are handled concurrently, so compare as sets of (event, text).
  assert.deepEqual(calls.map((c) => `${c[0]}:${c[2]}`).sort(), [
    'commandMessageCreate:!afk lunsj',
    'messageCreate:hello',
    'messageCreateAny:!afk lunsj',
    'messageCreateAny:hello',
  ]);
});

test('voice state changes from the tracker reach the modules keyed by the fluxer guild', async () => {
  const calls = [];
  const client = new EventEmitter();
  client.user = { id: BOT };
  client.channels = new Map();
  client.users = { fetch: async () => null };
  let listener;
  const voice = {
    track: (_client, cb) => {
      listener = cb;
    },
  };
  registerFluxerModuleEvents(client, {
    dispatch: async (event, key, payload) => calls.push({ event, key, payload }),
    voice,
  });
  const oldState = { guildId: RAW, channelId: null };
  const newState = { guildId: RAW, channelId: 'vc1' };
  listener(oldState, newState);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [
    { event: 'voiceStateUpdate', key: KEY, payload: { old: oldState, new: newState } },
  ]);
});
