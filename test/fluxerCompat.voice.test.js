import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { createVoiceTracker } from '../src/platform/voiceStates.js';
import { createGuildChannel, deleteGuildChannel } from '../src/platform/channels.js';

const voice = createVoiceTracker({ Collection });
installFluxerCompat(sdk, { Collection, voice });

const getterOf = (Class, name) => Object.getOwnPropertyDescriptor(Class.prototype, name).get;
const G = '900000000000000071';

function fakeGuildWithState() {
  const guild = { id: G, members: new Map(), channels: new Map() };
  const channel = { id: 'vc1', guildId: G };
  guild.channels.set('vc1', channel);
  const client = { guilds: new Map([[G, guild]]) };
  const member = { id: 'u1', guild, moves: [] };
  member.move = async (...args) => member.moves.push(args);
  guild.members.set('u1', member);
  voice.apply(client, {
    guild_id: G,
    user_id: 'u1',
    channel_id: 'vc1',
    connection_id: 'conn-1',
    self_mute: true,
  });
  return { guild, channel, member, client };
}

test('GuildMember.voice reads the tracked state', () => {
  const { member, channel } = fakeGuildWithState();
  const v = getterOf(sdk.GuildMember, 'voice').call(member);
  assert.equal(v.channelId, 'vc1');
  assert.equal(v.channel, channel);
  assert.equal(v.selfMute, true);
  assert.equal(v.selfDeaf, false);
});

test('GuildMember.voice for a member who is not connected', () => {
  const { guild } = fakeGuildWithState();
  const other = { id: 'u9', guild };
  const v = getterOf(sdk.GuildMember, 'voice').call(other);
  assert.equal(v.channelId, null);
  assert.equal(v.channel, null);
});

test('GuildMember.voice.setChannel / disconnect move the right connection', async () => {
  const { member } = fakeGuildWithState();
  const v = getterOf(sdk.GuildMember, 'voice').call(member);
  await v.setChannel({ id: 'vc2' });
  await v.disconnect('why');
  assert.deepEqual(member.moves, [
    ['vc2', 'conn-1'],
    [null, 'conn-1'],
  ]);
});

test('Guild.voiceStates.cache is the guild tracked states', () => {
  const { guild } = fakeGuildWithState();
  const cache = getterOf(sdk.Guild, 'voiceStates').call(guild).cache;
  assert.deepEqual([...cache.keys()], ['u1']);
});

test('GuildChannel.members lists the members connected to that channel', () => {
  const { channel, member } = fakeGuildWithState();
  const members = getterOf(sdk.GuildChannel, 'members').call(channel);
  assert.equal(members.size, 1);
  assert.equal(members.first(), member);
  assert.equal(members.has('u1'), true);
});

test('Guild.maximumBitrate is a fixed ceiling (Fluxer has no boost tiers)', () => {
  assert.equal(getterOf(sdk.Guild, 'maximumBitrate').call({}), 384_000);
});

test('a channel collection without fetch() resolves from its cache instead of throwing', async () => {
  const c = new Collection([['a', { id: 'a' }]]);
  assert.deepEqual(await c.fetch('a'), { id: 'a' });
  assert.equal(await c.fetch('missing'), null);
});

// --- channel create / delete -------------------------------------------------

test('createGuildChannel on a Fluxer guild translates discord.js options into createChannel()', async () => {
  const calls = [];
  const guild = {
    id: G,
    roles: new Map([['r1', {}]]),
    createChannel: async (o) => {
      calls.push(o);
      return { id: 'new' };
    },
  };
  const create = sdk.Guild.prototype.createChannelCompat;
  assert.equal(typeof create, 'function');
  const bit = sdk.PermissionFlags.ViewChannel;
  await create.call(guild, {
    name: 'room',
    type: 2,
    parent: { id: 'cat1' },
    bitrate: 64000,
    userLimit: 4,
    reason: 'x',
    permissionOverwrites: [
      { id: G, allow: [], deny: ['ViewChannel'] },
      { id: 'r1', allow: [bit] },
      { id: 'u5', allow: ['ViewChannel', 'SendMessages'] },
    ],
  });
  const o = calls[0];
  assert.equal(o.name, 'room');
  assert.equal(o.type, 2);
  assert.equal(o.parentId, 'cat1');
  assert.equal(o.bitrate, 64000);
  assert.equal(o.userLimit, 4);
  assert.deepEqual(
    o.permissionOverwrites.map((p) => [p.id, p.type, p.allow, p.deny]),
    [
      [G, sdk.OverwriteType.Role, 0n, bit],
      ['r1', sdk.OverwriteType.Role, bit, 0n],
      ['u5', sdk.OverwriteType.Member, bit | sdk.PermissionFlags.SendMessages, 0n],
    ]
  );
});

test('createGuildChannel uses guild.channels.create on a platform that has it', async () => {
  const calls = [];
  const guild = { channels: { create: async (o) => calls.push(o) } };
  await createGuildChannel(guild, { name: 'x' });
  assert.deepEqual(calls, [{ name: 'x' }]);
});

test('createGuildChannel prefers the compat method when the guild has it', async () => {
  const calls = [];
  const guild = {
    createChannelCompat: async (o) => calls.push(o),
    channels: { create: async () => assert.fail('wrong path') },
  };
  await createGuildChannel(guild, { name: 'y' });
  assert.deepEqual(calls, [{ name: 'y' }]);
});

test('deleteGuildChannel deletes the cached channel itself, and tolerates a missing one', async () => {
  const deleted = [];
  const guild = {
    channels: {
      cache: new Map([['c1', { id: 'c1', delete: async (reason) => deleted.push(['c1', reason]) }]]),
    },
  };
  await deleteGuildChannel(guild, 'c1', 'cleanup');
  await deleteGuildChannel(guild, 'gone', 'cleanup');
  assert.deepEqual(deleted, [['c1', 'cleanup']]);
});

test('deleteGuildChannel falls back to guild.channels.delete for an uncached channel on discord.js', async () => {
  const calls = [];
  const guild = { channels: { cache: new Map(), delete: async (id, reason) => calls.push([id, reason]) } };
  await deleteGuildChannel(guild, 'c9', 'r');
  assert.deepEqual(calls, [['c9', 'r']]);
});
