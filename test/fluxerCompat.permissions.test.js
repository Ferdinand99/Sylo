// channel.permissionsFor(role) on Fluxer, against the real SDK classes (GuildChannel, Role, the
// overwrite manager and the permission bit field) with the compat layer installed. The SDK can only
// compute permissions for a member; the quote board and the public event pages ask about the
// @everyone role to find out whether a channel is public, and before the alias answered for a role
// every Fluxer channel counted as private.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';
import { Collection } from '@fluxerjs/collection';
import { installFluxerCompat } from '../src/platform/compat.js';
import { isPublicSource } from '../src/modules/quoteBoard.js';
import { channelIsPublic } from '../src/modules/lib/eventPage.js';

installFluxerCompat(sdk, { Collection });

const GID = '900000000000000500';
const ADMIN = '900000000000000501';
const MOD = '900000000000000502';
const F = sdk.PermissionFlags;
const roleData = (id, permissions, position = 0) => ({
  id,
  name: id === GID ? '@everyone' : `role-${id.slice(-3)}`,
  color: 0,
  position,
  permissions: String(permissions),
});
const overwrite = (id, { allow = 0n, deny = 0n } = {}) => ({
  id,
  type: sdk.OverwriteType.Role,
  allow: String(allow),
  deny: String(deny),
});

/** A guild with real roles, and a real GuildChannel with the given overwrites. */
function world({ everyone = F.ViewChannel | F.SendMessages, overwrites = [], extra = {}, nsfw } = {}) {
  const roles = new sdk.GuildRoleManager(GID, {});
  const guild = { id: GID, roles, members: new Collection(), channels: new Collection() };
  const client = { guilds: new Collection([[GID, guild]]) };
  roles.set(GID, new sdk.Role(client, roleData(GID, everyone), GID));
  roles.set(ADMIN, new sdk.Role(client, roleData(ADMIN, F.Administrator, 5), GID));
  roles.set(MOD, new sdk.Role(client, roleData(MOD, F.SendMessages, 3), GID));
  const channel = new sdk.GuildChannel(client, {
    id: '900000000000000600',
    type: 0,
    guild_id: GID,
    name: 'general',
    permission_overwrites: overwrites,
    ...extra,
  });
  if (nsfw !== undefined) channel.nsfw = nsfw;
  guild.channels.set(channel.id, channel);
  return { guild, channel, everyone: roles.get(GID), mod: roles.get(MOD), admin: roles.get(ADMIN) };
}

test('the @everyone role may view a channel its role permissions allow, and the answer is a real bit field', () => {
  const { channel, everyone } = world();
  const perms = channel.permissionsFor(everyone);
  assert.ok(perms instanceof sdk.PermissionsBitField);
  assert.equal(perms.has('ViewChannel'), true);
  assert.equal(perms.has('ManageChannels'), false);
  assert.equal(channel.permissionsFor(everyone.id).has('ViewChannel'), true, 'by id');
});

test('a channel overwrite for @everyone can take the view away, or give it', () => {
  const closed = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  assert.equal(closed.channel.permissionsFor(closed.everyone).has('ViewChannel'), false);
  assert.equal(
    closed.channel.permissionsFor(closed.everyone).has('SendMessages'),
    true,
    'only the denied bit'
  );

  const opened = world({ everyone: F.SendMessages, overwrites: [overwrite(GID, { allow: F.ViewChannel })] });
  assert.equal(opened.channel.permissionsFor(opened.everyone).has('ViewChannel'), true);

  const hiddenByDefault = world({ everyone: F.SendMessages });
  assert.equal(hiddenByDefault.channel.permissionsFor(hiddenByDefault.everyone).has('ViewChannel'), false);
});

test('another role starts from its own permissions, then the @everyone overwrite, then its own', () => {
  const staffOnly = world({
    overwrites: [overwrite(GID, { deny: F.ViewChannel }), overwrite(MOD, { allow: F.ViewChannel })],
  });
  assert.equal(staffOnly.channel.permissionsFor(staffOnly.everyone).has('ViewChannel'), false);
  assert.equal(staffOnly.channel.permissionsFor(staffOnly.mod).has('ViewChannel'), true);
  assert.equal(staffOnly.channel.permissionsFor(MOD).has('ViewChannel'), true, 'by id');
});

test('an Administrator role may do everything in every channel', () => {
  const { channel, admin } = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  assert.equal(channel.permissionsFor(admin).has('ViewChannel'), true);
  assert.equal(channel.permissionsFor(admin).has('ManageGuild'), true);
});

test('an unknown role id, an empty target and a member id that is not cached all answer null', () => {
  const { channel } = world();
  assert.equal(channel.permissionsFor('900000000000000999'), null);
  assert.equal(channel.permissionsFor(null), null);
  assert.equal(channel.permissionsFor(undefined), null);
  assert.equal(channel.permissionsFor({}), null);
});

test('a member is still answered by the SDK, ahead of a role with the same id', () => {
  const { channel, guild } = world();
  const perms = { has: () => true };
  guild.members.set('900000000000000700', { id: '900000000000000700', permissionsIn: () => perms });
  assert.equal(channel.permissionsFor('900000000000000700'), perms);
});

test('the quote board and the event pages now see a public Fluxer channel as public', () => {
  const open = world();
  assert.equal(isPublicSource(open.guild, open.channel), true);
  assert.equal(channelIsPublic(open.guild, open.channel.id), true);

  const staff = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  assert.equal(isPublicSource(staff.guild, staff.channel), false);
  assert.equal(channelIsPublic(staff.guild, staff.channel.id), false);

  const hidden = world({ everyone: F.SendMessages });
  assert.equal(channelIsPublic(hidden.guild, hidden.channel.id), false);

  const adult = world({ nsfw: true });
  assert.equal(channelIsPublic(adult.guild, adult.channel.id), false, 'age-restricted');
});

test('fails closed on Fluxer: a guild without its @everyone role, or a channel that is not cached', () => {
  const { guild, channel } = world();
  guild.roles.delete(GID);
  assert.equal(channelIsPublic(guild, channel.id), false);
  const other = world();
  assert.equal(channelIsPublic(other.guild, '900000000000000999'), false);
});
