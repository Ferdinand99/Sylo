import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';

// Members, roles, messages and reactions. Each alias is read off the real SDK
// class after installing, then called against a minimal stand-in for `this`.
installFluxerCompat(sdk, { Collection });

const getterOf = (Class, name) => Object.getOwnPropertyDescriptor(Class.prototype, name).get;
const methodOf = (Class, name) => Class.prototype[name];

// --- members -------------------------------------------------------------------

test('GuildMember.nickname / setNickname / send / timeout helpers', async () => {
  assert.equal(getterOf(sdk.GuildMember, 'nickname').call({ nick: 'Fer' }), 'Fer');
  assert.equal(getterOf(sdk.GuildMember, 'nickname').call({ nick: undefined }), null);

  const edits = [];
  await methodOf(sdk.GuildMember, 'setNickname').call({ edit: async (o) => edits.push(o) }, 'Fer', 'why');
  assert.deepEqual(edits, [{ nick: 'Fer', reason: 'why' }]);

  const sent = [];
  await methodOf(sdk.GuildMember, 'send').call({ user: { send: async (o) => sent.push(o) } }, 'hi');
  assert.deepEqual(sent, ['hi']);

  const until = new Date(Date.now() + 60_000);
  const timedOut = { communicationDisabledUntil: until };
  assert.equal(
    getterOf(sdk.GuildMember, 'communicationDisabledUntilTimestamp').call(timedOut),
    until.getTime()
  );
  assert.equal(methodOf(sdk.GuildMember, 'isCommunicationDisabled').call(timedOut), true);
  const expired = { communicationDisabledUntil: new Date(Date.now() - 1000) };
  assert.equal(methodOf(sdk.GuildMember, 'isCommunicationDisabled').call(expired), false);
  assert.equal(getterOf(sdk.GuildMember, 'communicationDisabledUntilTimestamp').call({}), null);
});

test('GuildMember.manageable: not the owner, not the bot, and ranked below the bot', () => {
  const manageable = getterOf(sdk.GuildMember, 'manageable');
  const guild = (ownerId, botTop) => ({
    ownerId,
    members: { me: { id: 'bot', roles: { highest: { position: botTop } } } },
  });
  const member = (id, top, g) => ({ id, guild: g, roles: { highest: { position: top } } });
  assert.equal(manageable.call(member('u1', 1, guild('owner', 5))), true);
  assert.equal(manageable.call(member('u1', 5, guild('owner', 5))), false); // equal rank
  assert.equal(manageable.call(member('owner', 1, guild('owner', 5))), false);
  assert.equal(manageable.call(member('bot', 1, guild('owner', 5))), false);
  assert.equal(manageable.call(member('u1', 9, guild('bot', 1))), true); // the bot owns the guild
});

test('GuildMemberManager.fetch handles the discord.js call forms', async () => {
  const calls = [];
  const Native = class {
    async fetch(arg, options) {
      calls.push([arg, options]);
      if (typeof arg === 'string') return { id: arg };
      if (arg?.after === 'p1') return [{ id: 'c' }];
      return [{ id: 'a' }, { id: 'b' }];
    }
  };
  installFluxerCompat({ ...sdk, GuildMemberManager: Native }, { Collection });
  const manager = new Native();
  assert.deepEqual(await manager.fetch('u1'), { id: 'u1' });
  const many = await manager.fetch({ user: ['x', 'y'] });
  assert.deepEqual([...many.keys()], ['x', 'y']);
  assert.deepEqual((await manager.fetch({ user: 'z' })).id, 'z');
  const all = await manager.fetch();
  assert.deepEqual([...all.keys()], ['a', 'b']); // fewer than a full page: one request
});

test('GuildMemberRoleManager.add / remove take one role or several, and highest is the top role', async () => {
  const calls = [];
  const Native = class {
    async add(id) {
      calls.push(['add', id]);
    }
    async remove(id) {
      calls.push(['remove', id]);
    }
  };
  installFluxerCompat({ ...sdk, GuildMemberRoleManager: Native }, { Collection });
  const roles = Object.assign(new Native(), { member: { id: 'm' } });
  await roles.add({ id: 'r1' });
  await roles.add(['r2', { id: 'r3' }]);
  await roles.remove('r1');
  assert.deepEqual(calls, [
    ['add', 'r1'],
    ['add', 'r2'],
    ['add', 'r3'],
    ['remove', 'r1'],
  ]);

  const highest = getterOf(sdk.GuildMemberRoleManager, 'highest');
  const cache = new Map([
    ['a', { position: 1 }],
    ['b', { position: 4 }],
  ]);
  assert.equal(highest.call({ cache, member: { guild: { roles: { everyone: 'ev' } } } }).position, 4);
  assert.equal(highest.call({ cache: new Map(), member: { guild: { roles: { everyone: 'ev' } } } }), 'ev');
});

// --- roles, emojis, bans, invites ----------------------------------------------

test('Role helpers: hexColor, members, comparePositionTo, guild, editable, managed', () => {
  assert.equal(getterOf(sdk.Role, 'hexColor').call({ color: 0x5b7cfa }), '#5b7cfa');
  assert.equal(getterOf(sdk.Role, 'hexColor').call({ color: 0 }), '#000000');

  const guild = {
    ownerId: 'owner',
    roles: { get: (id) => (id === 'r2' ? { position: 3 } : undefined) },
    members: new Map([
      ['u1', { id: 'u1', roles: { cache: new Map([['r1', {}]]) } }],
      ['u2', { id: 'u2', roles: { cache: new Map() } }],
    ]),
  };
  Object.defineProperty(guild.members, 'me', {
    value: { id: 'bot', permissions: { has: () => true }, roles: { highest: { position: 5 } } },
  });
  const role = { id: 'r1', guildId: 'g', position: 2, client: { guilds: { get: () => guild } }, guild };
  assert.deepEqual([...getterOf(sdk.Role, 'members').call(role).keys()], ['u1']);
  assert.equal(methodOf(sdk.Role, 'comparePositionTo').call(role, 'r2'), -1);
  assert.equal(methodOf(sdk.Role, 'comparePositionTo').call(role, { position: 1 }), 1);
  assert.equal(getterOf(sdk.Role, 'guild').call(role), guild);
  assert.equal(getterOf(sdk.Role, 'editable').call(role), true);
  assert.equal(getterOf(sdk.Role, 'editable').call({ ...role, id: 'g' }), false); // @everyone
  assert.equal(getterOf(sdk.Role, 'managed').call({}), false);
});

test('GuildEmoji.imageURL, GuildBan.guild and Invite.guild', () => {
  assert.equal(methodOf(sdk.GuildEmoji, 'imageURL').call({ url: 'https://x/e.png' }), 'https://x/e.png');
  const guild = { id: 'g' };
  const client = { guilds: { get: (id) => (id === 'g' ? guild : undefined) } };
  assert.equal(getterOf(sdk.GuildBan, 'guild').call({ client, guildId: 'g' }), guild);
  assert.equal(getterOf(sdk.Invite, 'guild').call({ client, guildSnapshot: { id: 'g' } }), guild);
  assert.equal(getterOf(sdk.Invite, 'guild').call({ client, guildSnapshot: null }), null);
});

// --- messages and reactions ----------------------------------------------------

test('Message.inGuild / url / deletable / editable', () => {
  assert.equal(methodOf(sdk.Message, 'inGuild').call({ guildId: 'g' }), true);
  assert.equal(methodOf(sdk.Message, 'inGuild').call({ guildId: null }), false);

  const client = {
    user: { id: 'bot' },
    instance: { endpoints: { webapp: 'https://f.test' } },
    channels: new Map(),
  };
  const url = getterOf(sdk.Message, 'url');
  assert.equal(url.call({ client, guildId: 'g', channelId: 'c', id: 'm' }), 'https://f.test/channels/g/c/m');
  assert.equal(
    url.call({ client, guildId: null, channelId: 'c', id: 'm' }),
    'https://f.test/channels/@me/c/m'
  );

  const deletable = getterOf(sdk.Message, 'deletable');
  assert.equal(deletable.call({ client, author: { id: 'bot' } }), true);
  const channel = {
    guildId: 'g',
    guild: { members: { me: { permissionsIn: () => ({ has: (p) => p === 'ManageMessages' }) } } },
  };
  assert.equal(deletable.call({ client, author: { id: 'u' }, channel }), true);
  assert.equal(
    deletable.call({ client, author: { id: 'u' }, channel: { ...channel, guildId: null } }),
    false
  );
  assert.equal(getterOf(sdk.Message, 'editable').call({ client, author: { id: 'bot' } }), true);
  assert.equal(getterOf(sdk.Message, 'editable').call({ client, author: { id: 'u' } }), false);
});

test('messages fetched over REST get their guild id from the channel', async () => {
  const stubMessage = (id) => ({ id, guildId: null, channelId: 'c1' });
  const Native = class {
    async fetch() {
      return stubMessage('m1');
    }
  };
  installFluxerCompat({ ...sdk, MessageManager: Native }, { Collection });
  const manager = Object.assign(new Native(), {
    client: { channels: new Map([['c1', { guildId: 'g1' }]]), guilds: new Map() },
  });
  assert.equal((await manager.fetch()).guildId, 'g1');
});

test('MessageManager.delete takes an id or a message', async () => {
  const deleted = [];
  const manager = {
    fetch: async (id) => ({ id, delete: async () => deleted.push(id) }),
  };
  await methodOf(sdk.MessageManager, 'delete').call(manager, 'm1');
  await methodOf(sdk.MessageManager, 'delete').call(manager, {
    id: 'm2',
    delete: async () => deleted.push('m2'),
  });
  assert.deepEqual(deleted, ['m1', 'm2']);
});

test('MessageReaction.partial / fetch / remove / users', async () => {
  assert.equal(getterOf(sdk.MessageReaction, 'partial').call({}), false);
  const reaction = { emojiIdentifier: '⭐', message: null, fetchMessage: async () => message };
  const removed = [];
  const message = {
    removeReactionEmoji: async (e) => removed.push(['emoji', e]),
    removeReaction: async (e, u) => removed.push(['user', e, u]),
    fetchReactionUsersPage: async (_e, opts) =>
      opts.after
        ? { users: [{ id: 'u3' }], hasMore: false }
        : { users: [{ id: 'u1' }, { id: 'u2' }], hasMore: true, nextAfter: 'u2' },
  };
  assert.equal(await methodOf(sdk.MessageReaction, 'fetch').call(reaction), reaction);
  await methodOf(sdk.MessageReaction, 'remove').call(reaction);
  const users = getterOf(sdk.MessageReaction, 'users').call(reaction);
  assert.deepEqual([...(await users.fetch()).keys()], ['u1', 'u2', 'u3']);
  await users.remove({ id: 'u1' });
  assert.deepEqual(removed, [
    ['emoji', '⭐'],
    ['user', '⭐', 'u1'],
  ]);
});

test('MessageReactionManager.removeAll clears the message reactions', async () => {
  let cleared = 0;
  const manager = {
    message: {
      id: 'm',
      channelId: 'c',
      client: {
        channels: { fetchMessage: async () => ({ removeAllReactions: async () => (cleared += 1) }) },
      },
    },
  };
  await methodOf(sdk.MessageReactionManager, 'removeAll').call(manager);
  assert.equal(cleared, 1);
});

test('every SDK method the compat layer wraps still exists (guards an SDK upgrade)', () => {
  for (const [Class, names] of [
    [sdk.GuildMemberManager, ['fetch']],
    [sdk.GuildMemberRoleManager, ['add', 'remove']],
    [sdk.MessageManager, ['fetch']],
    [sdk.ChannelManager, ['fetchMessage']],
    [sdk.MessageReaction, ['fetchMessage']],
    [sdk.Message, ['fetch']],
    [sdk.PartialMessage, ['fetch']],
  ]) {
    for (const n of names) assert.equal(typeof Class.prototype[n], 'function', `${Class.name}.${n}`);
  }
});
