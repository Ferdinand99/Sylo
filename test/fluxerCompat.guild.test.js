import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat, mergeLegacyOverwrite } from '../src/platform/compat.js';

// Users, guilds, channels, overwrites. Each alias is read off the real SDK
// class after installing, then called against a minimal stand-in for `this`.
installFluxerCompat(sdk, { Collection });

const getterOf = (Class, name) => Object.getOwnPropertyDescriptor(Class.prototype, name).get;
const methodOf = (Class, name) => Class.prototype[name];

test('User.tag: username, plus #discriminator when there is one', () => {
  const tag = getterOf(sdk.User, 'tag');
  assert.equal(tag.call({ username: 'ferdi', discriminator: '0' }), 'ferdi');
  assert.equal(tag.call({ username: 'ferdi', discriminator: '0000' }), 'ferdi');
  assert.equal(tag.call({ username: 'ferdi', discriminator: undefined }), 'ferdi');
  assert.equal(tag.call({ username: 'ferdi', discriminator: '2610' }), 'ferdi#2610');
});

test('Guild.systemChannel / rulesChannel / afkChannel resolve the stored channel ids', () => {
  const ch = { id: 'c1' };
  const guild = {
    systemChannelId: 'c1',
    rulesChannelId: null,
    channels: { get: (id) => (id === 'c1' ? ch : undefined) },
  };
  assert.equal(getterOf(sdk.Guild, 'systemChannel').call(guild), ch);
  assert.equal(getterOf(sdk.Guild, 'rulesChannel').call(guild), null);
  assert.equal(getterOf(sdk.Guild, 'afkChannel').call(guild), null);
});

test('Guild.bans: create / remove / fetch over the SDK ban methods', async () => {
  const calls = [];
  const guild = {
    ban: async (id, opts) => calls.push(['ban', id, opts]),
    unban: async (id, reason) => calls.push(['unban', id, reason]),
    fetchBans: async () => [{ user: { id: 'u1' } }, { user: { id: 'u2' } }],
    client: { users: { fetch: async () => null } },
  };
  const bans = getterOf(sdk.Guild, 'bans').call(guild);
  await bans.create({ id: 'u1' }, { reason: 'spam' });
  await bans.remove('u1', 'appeal');
  assert.deepEqual(calls, [
    ['ban', 'u1', { reason: 'spam' }],
    ['unban', 'u1', 'appeal'],
  ]);
  assert.deepEqual([...(await bans.fetch()).keys()], ['u1', 'u2']);
  assert.equal((await bans.fetch('u2')).user.id, 'u2');
  assert.equal((await bans.fetch({ user: 'u1' })).user.id, 'u1');
  await assert.rejects(bans.fetch('nope'), (e) => e.code === 10026); // discord.js's Unknown Ban
});

test('Guild.invites.fetch: a Collection keyed by code', async () => {
  const guild = { fetchInvites: async () => [{ code: 'a' }, { code: 'b' }] };
  const invites = await getterOf(sdk.Guild, 'invites').call(guild).fetch();
  assert.deepEqual([...invites.keys()], ['a', 'b']);
});

test('GuildChannel.guild comes from the client cache', () => {
  const guild = { id: 'g' };
  const channel = { guildId: 'g', client: { guilds: { get: (id) => (id === 'g' ? guild : undefined) } } };
  assert.equal(getterOf(sdk.GuildChannel, 'guild').call(channel), guild);
  assert.equal(getterOf(sdk.GuildChannel, 'guild').call({ guildId: null, client: {} }), null);
});

test('GuildChannel.permissionsFor: a member object or an id, null when unknown', () => {
  const perms = { has: () => true };
  const member = { id: 'u1', permissionsIn: () => perms };
  const channel = { guild: { members: { get: (id) => (id === 'u1' ? member : undefined) } } };
  const permissionsFor = methodOf(sdk.GuildChannel, 'permissionsFor');
  assert.equal(permissionsFor.call(channel, member), perms);
  assert.equal(permissionsFor.call(channel, 'u1'), perms);
  assert.equal(permissionsFor.call(channel, 'ghost'), null);
  assert.equal(permissionsFor.call(channel, null), null);
});

test("GuildChannel viewable / manageable / deletable follow the bot's own permissions", () => {
  const make = (granted) => ({
    guild: { members: { me: { permissionsIn: () => ({ has: (p) => granted.includes(p) }) } } },
  });
  const viewable = getterOf(sdk.GuildChannel, 'viewable');
  const manageable = getterOf(sdk.GuildChannel, 'manageable');
  assert.equal(viewable.call(make(['ViewChannel'])), true);
  assert.equal(viewable.call(make([])), false);
  assert.equal(viewable.call({ guild: null }), false);
  assert.equal(manageable.call(make(['ViewChannel', 'ManageChannels'])), true);
  assert.equal(manageable.call(make(['ViewChannel'])), false);
  const deletable = getterOf(sdk.GuildChannel, 'deletable');
  assert.equal(deletable.call({ manageable: true }), true);
});

test('GuildChannel.setName / setRateLimitPerUser / setUserLimit edit the channel', async () => {
  const edits = [];
  const channel = { edit: async (o) => edits.push(o) };
  await methodOf(sdk.GuildChannel, 'setName').call(channel, 'new', 'why');
  await methodOf(sdk.GuildChannel, 'setRateLimitPerUser').call(channel, 5, 'slow');
  await methodOf(sdk.GuildChannel, 'setUserLimit').call(channel, 3);
  assert.deepEqual(edits, [
    { name: 'new', reason: 'why' },
    { rateLimitPerUser: 5, reason: 'slow' },
    { userLimit: 3, reason: undefined },
  ]);
});

test('overwrites: the discord.js true / false / null form is merged onto the existing bits', () => {
  const flags = sdk.PermissionFlags;
  const { allow, deny } = mergeLegacyOverwrite(0n, 4n, { SendMessages: false, ViewChannel: true }, flags);
  assert.equal(allow, flags.ViewChannel);
  assert.equal(deny, 4n | flags.SendMessages);
  const cleared = mergeLegacyOverwrite(allow, deny, { SendMessages: null, ViewChannel: null }, flags);
  assert.equal(cleared.allow, 0n);
  assert.equal(cleared.deny, 4n);
});

test('PermissionOverwriteManager.edit translates the discord.js form and resolves role / member objects', async () => {
  const sent = [];
  const Native = class {
    edit(id, opts) {
      sent.push([id, opts]);
    }
    delete(id) {
      sent.push(['delete', id]);
    }
  };
  const stub = { ...sdk, PermissionOverwriteManager: Native };
  installFluxerCompat(stub, { Collection });
  const manager = Object.assign(new Native(), {
    cache: new Map([['r1', { _allow: 0n, _deny: 0n, type: 0 }]]),
    channel: { guildId: 'g', guild: { roles: { get: () => ({}) } } },
  });
  await manager.edit({ id: 'r1' }, { SendMessages: false });
  assert.deepEqual(sent[0], ['r1', { type: 0, allow: 0n, deny: sdk.PermissionFlags.SendMessages }]);
  // The SDK's own { type, allow, deny } shape is passed through untouched, with the target resolved to an id.
  await manager.edit({ id: 'r1' }, { type: 0, allow: 1n, deny: 0n });
  assert.deepEqual(sent[1], ['r1', { type: 0, allow: 1n, deny: 0n }]);
  await manager.delete({ id: 'r1' });
  assert.deepEqual(sent[2], ['delete', 'r1']);
});

test('Channel.bulkDelete takes a count, ids or messages, filters old ones, and resolves to a Collection', async () => {
  const deleted = [];
  const Native = class {
    async bulkDelete(arg) {
      const ids = typeof arg === 'number' ? ['x', 'y'] : arg;
      deleted.push(ids);
      return ids;
    }
  };
  installFluxerCompat({ ...sdk, Channel: Native }, { Collection });
  const channel = new Native();
  const byCount = await channel.bulkDelete(2);
  assert.deepEqual([...byCount.keys()], ['x', 'y']);
  const old = { id: 'old', createdTimestamp: Date.now() - 20 * 86_400_000 };
  const fresh = { id: 'fresh', createdTimestamp: Date.now() };
  const filtered = await channel.bulkDelete(
    new Map([
      ['old', old],
      ['fresh', fresh],
    ]),
    true
  );
  assert.deepEqual([...filtered.keys()], ['fresh']);
  assert.deepEqual(deleted.at(-1), ['fresh']);
  assert.equal((await channel.bulkDelete(['a', 'b'])).size, 2);
});

test('EmbedBuilder.addFields takes both addFields(a, b) and addFields([a, b])', () => {
  const list = new sdk.EmbedBuilder().addFields([
    { name: 'a', value: '1' },
    { name: 'b', value: '2' },
  ]);
  assert.equal(list.toJSON().fields.length, 2);
  const spread = new sdk.EmbedBuilder().addFields({ name: 'a', value: '1' }, { name: 'b', value: '2' });
  assert.equal(spread.toJSON().fields.length, 2);
});

test('Collection.hasAny / hasAll exist like in discord.js', () => {
  const c = new Collection([
    ['a', 1],
    ['b', 2],
  ]);
  assert.equal(c.hasAny('x', 'a'), true);
  assert.equal(c.hasAny('x'), false);
  assert.equal(c.hasAll('a', 'b'), true);
  assert.equal(c.hasAll('a', 'x'), false);
});

test('every SDK method the compat layer wraps still exists (guards an SDK upgrade)', () => {
  for (const [Class, names] of [
    [sdk.PermissionOverwriteManager, ['edit', 'delete']],
    [sdk.Channel, ['bulkDelete']],
    [sdk.EmbedBuilder, ['addFields']],
  ]) {
    for (const n of names) assert.equal(typeof Class.prototype[n], 'function', `${Class.name}.${n}`);
  }
});

test('User._patch: a bare payload (a ban event carries only the id) keeps the name already known', () => {
  const user = new sdk.User({}, { id: '1', username: 'ferdi', discriminator: '2610', global_name: 'Ferdi' });
  user._patch({ id: '1' });
  assert.equal(user.username, 'ferdi');
  assert.equal(user.discriminator, '2610');
  assert.equal(user.globalName, 'Ferdi');
  assert.equal(user.tag, 'ferdi#2610');
  user._patch({ id: '1', username: 'renamed', discriminator: '0', global_name: null });
  assert.equal(user.tag, 'renamed', 'a full payload still updates the user');
  assert.equal(user.globalName, null);
});

test('Guild.bans.fetch(id): a banned user the SDK only knows by id is filled in from the API', async () => {
  const fetched = [];
  const bare = { id: 'u9', username: undefined };
  const guild = {
    fetchBans: async () => [{ user: bare }],
    client: {
      users: {
        fetch: async (id, opts) => {
          fetched.push([id, opts]);
          bare.username = 'nine';
          return bare;
        },
      },
    },
  };
  const bans = getterOf(sdk.Guild, 'bans').call(guild);
  const ban = await bans.fetch('u9');
  assert.equal(ban.user.username, 'nine');
  assert.deepEqual(fetched, [['u9', { force: true }]]);

  // A known user costs no extra request.
  fetched.length = 0;
  await bans.fetch('u9');
  assert.deepEqual(fetched, []);
});
