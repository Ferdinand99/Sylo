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
import { runtime } from '../src/runtime.js';
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

/**
 * A guild with real roles, and real channels made the way the SDK makes them (Channel.from): the
 * text channel `general` with the given overwrites and age-restriction fields, and, when `category`
 * is given, the category it sits under.
 *  - `nsfw`: the channel's own stored flag; `nsfwOverride`: its override (null = inherits)
 *  - `category`: { override } with true, false, null (inherits) or 'absent' (the payload has no field)
 *  - `guildNsfw`: the server's flag
 */
function world({
  everyone = F.ViewChannel | F.SendMessages,
  overwrites = [],
  nsfw = false,
  nsfwOverride = null,
  category,
  guildNsfw = false,
} = {}) {
  const roles = new sdk.GuildRoleManager(GID, {});
  const guild = { id: GID, roles, members: new Collection(), channels: new Collection(), nsfw: guildNsfw };
  const client = { guilds: new Collection([[GID, guild]]) };
  guild.client = client;
  runtime.clients.fluxer = client;
  roles.set(GID, new sdk.Role(client, roleData(GID, everyone), GID));
  roles.set(ADMIN, new sdk.Role(client, roleData(ADMIN, F.Administrator, 5), GID));
  roles.set(MOD, new sdk.Role(client, roleData(MOD, F.SendMessages, 3), GID));
  let cat;
  if (category) {
    cat = sdk.Channel.from(client, {
      id: '900000000000000650',
      type: 4,
      guild_id: GID,
      name: 'Category',
      ...(category.override === 'absent' ? {} : { nsfw_override: category.override }),
    });
    guild.channels.set(cat.id, cat);
  }
  const channel = sdk.Channel.from(client, {
    id: '900000000000000600',
    type: 0,
    guild_id: GID,
    name: 'general',
    parent_id: cat?.id ?? null,
    permission_overwrites: overwrites,
    nsfw,
    nsfw_override: nsfwOverride,
  });
  guild.channels.set(channel.id, channel);
  return {
    guild,
    channel,
    category: cat,
    everyone: roles.get(GID),
    mod: roles.get(MOD),
    admin: roles.get(ADMIN),
  };
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

test('a member is answered by the SDK, ahead of a role with the same id', () => {
  const { channel, guild } = world();
  // A role and a member that share an id (unlikely, but the order is settled): the member wins,
  // so what comes back is not the permissions of the role (which may do nothing).
  const SAME = '900000000000000700';
  guild.roles.set(SAME, new sdk.Role(guild.client, roleData(SAME, 0n, 1), GID));
  const perms = { has: () => true, fromMember: true };
  guild.members.set(SAME, { id: SAME, permissionsIn: () => perms });
  assert.equal(channel.permissionsFor(SAME), perms, 'by id');
  assert.equal(channel.permissionsFor({ id: SAME, permissionsIn: () => perms }), perms, 'by object');
  // with no member of that id, the same id is read as the role
  guild.members.delete(SAME);
  const asRole = channel.permissionsFor(SAME);
  assert.ok(asRole instanceof sdk.PermissionsBitField);
  assert.equal(asRole.has('ViewChannel'), false);
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

// --- age restriction on Fluxer ---------------------------------------------------------------

test('a Fluxer channel is age-restricted by its own override, its category or the server', () => {
  const publicInAll = world({ category: { override: null } });
  assert.equal(channelIsPublic(publicInAll.guild, publicInAll.channel.id), true);

  // the channel's own override
  const own = world({ nsfwOverride: true });
  assert.equal(channelIsPublic(own.guild, own.channel.id), false, 'override true');

  // inherited from the category: the channel itself says nothing
  const underAdult = world({ category: { override: true } });
  assert.equal(underAdult.channel.nsfw, false);
  assert.equal(underAdult.channel.nsfwOverride, null);
  assert.equal(underAdult.category.nsfwOverride, true, 'the compat layer kept the category override');
  assert.equal(channelIsPublic(underAdult.guild, underAdult.channel.id), false, 'category true');
  assert.equal(isPublicSource(underAdult.guild, underAdult.channel), false);

  // inherited from the server
  const adultServer = world({ guildNsfw: true });
  assert.equal(channelIsPublic(adultServer.guild, adultServer.channel.id), false, 'server flag');
  assert.equal(isPublicSource(adultServer.guild, adultServer.channel), false);
  const adultServerUnderCategory = world({ guildNsfw: true, category: { override: null } });
  assert.equal(channelIsPublic(adultServerUnderCategory.guild, adultServerUnderCategory.channel.id), false);
});

test('an override beats what it would inherit, as Fluxer decides it', () => {
  const channelSafe = world({ nsfwOverride: false, category: { override: true }, guildNsfw: true });
  assert.equal(channelIsPublic(channelSafe.guild, channelSafe.channel.id), true, 'channel says safe');
  const categorySafe = world({ category: { override: false }, guildNsfw: true });
  assert.equal(channelIsPublic(categorySafe.guild, categorySafe.channel.id), true, 'category says safe');
  const channelAdult = world({ nsfwOverride: true, category: { override: false } });
  assert.equal(channelIsPublic(channelAdult.guild, channelAdult.channel.id), false);
});

test('a category override is kept when the category is updated, too', () => {
  const w = world({ category: { override: null } });
  assert.equal(channelIsPublic(w.guild, w.channel.id), true);
  w.category._patch({ nsfw_override: true });
  assert.equal(w.category.nsfwOverride, true);
  assert.equal(channelIsPublic(w.guild, w.channel.id), false, 'now age-restricted');
  w.category._patch({ nsfw_override: null });
  assert.equal(channelIsPublic(w.guild, w.channel.id), true);
  w.category._patch({ name: 'renamed' }); // an update without the field changes nothing
  assert.equal(w.category.nsfwOverride, null);
});

test('it fails closed when a flag cannot be read', () => {
  // the category payload had no override field at all
  const absent = world({ category: { override: 'absent' } });
  assert.equal(absent.category.nsfwOverride, undefined);
  assert.equal(channelIsPublic(absent.guild, absent.channel.id), false, 'category flag missing');

  // the category is not in the cache
  const lost = world({ category: { override: null } });
  lost.guild.channels.delete(lost.category.id);
  assert.equal(channelIsPublic(lost.guild, lost.channel.id), false, 'category unknown');

  // the server flag is missing or odd
  const noFlag = world();
  delete noFlag.guild.nsfw;
  assert.equal(channelIsPublic(noFlag.guild, noFlag.channel.id), false, 'server flag missing');
  const odd = world();
  odd.guild.nsfw = 'no';
  assert.equal(channelIsPublic(odd.guild, odd.channel.id), false, 'server flag odd');

  // the channel's own override is missing or odd
  const missing = world();
  delete missing.channel.nsfwOverride;
  assert.equal(channelIsPublic(missing.guild, missing.channel.id), false, 'channel override missing');
  const strange = world({ nsfwOverride: 'maybe' });
  assert.equal(channelIsPublic(strange.guild, strange.channel.id), false, 'channel override odd');
});

test('the quote board gets the same protection, because it asks the same question', () => {
  const w = world({ category: { override: true } });
  assert.equal(isPublicSource(w.guild, w.channel), false);
  const open = world({ category: { override: false } });
  assert.equal(isPublicSource(open.guild, open.channel), true);
});

test('Discord is unchanged: its channel flag is the effective one, and the Fluxer fields are not read', () => {
  const { guild, channel } = world({ category: { override: true }, guildNsfw: true });
  // The same objects on a guild that belongs to the Discord client: only channel.nsfw counts.
  runtime.clients.fluxer = null;
  assert.equal(isPublicSource(guild, channel), true, 'no Fluxer rule off Fluxer');
  channel.nsfw = true;
  assert.equal(isPublicSource(guild, channel), false, 'the plain flag still hides it');
});

// --- channel.permissionsFor(member), on the real SDK classes -----------------------------------------
//
// The SDK's own member.permissionsIn applies an overwrite only for a role id in the member's role
// list, and that list does not hold @everyone, so an overwrite that closes a channel to @everyone
// never reached a member. permissionsFor(member) works it out the way discord.js does.

const MEMBER = '900000000000000750';
/** A real GuildMember of the world's server, holding the given roles (never @everyone). */
function memberOf(w, roleIds, id = MEMBER) {
  w.guild.client.getOrCreateUser = (user) => user;
  return new sdk.GuildMember(
    w.guild.client,
    {
      user: { id, username: 'someone', discriminator: '0', global_name: null, avatar: null },
      roles: roleIds,
      joined_at: new Date(0).toISOString(),
    },
    w.guild
  );
}
const canView = (w, member) => w.channel.permissionsFor(member).has('ViewChannel');

test('a member of a channel closed to @everyone cannot view it, though the SDK alone says they can', () => {
  const w = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  const member = memberOf(w, []);
  assert.equal(
    member.permissionsIn(w.channel).has('ViewChannel'),
    true,
    'the SDK ignores the @everyone overwrite'
  );
  assert.ok(w.channel.permissionsFor(member) instanceof sdk.PermissionsBitField);
  assert.equal(canView(w, member), false, 'the compat layer applies it');
  assert.equal(w.channel.permissionsFor(MEMBER) ?? null, null, 'a member that is not cached is unknown');
  w.guild.members.set(MEMBER, member);
  assert.equal(w.channel.permissionsFor(MEMBER).has('ViewChannel'), false, 'by id, from the cache');
});

test('a role can open a channel again, and the role overwrites come after the @everyone one', () => {
  const w = world({
    overwrites: [overwrite(MOD, { allow: F.ViewChannel }), overwrite(GID, { deny: F.ViewChannel })], // in either order
  });
  assert.equal(canView(w, memberOf(w, [MOD])), true);
  assert.equal(canView(w, memberOf(w, [])), false);
  assert.equal(canView(w, memberOf(w, [ADMIN])), true, 'Administrator');
});

test('a role overwrite can also close a channel, and the roles of a member are taken together', () => {
  const w = world({ overwrites: [overwrite(MOD, { deny: F.ViewChannel })] });
  assert.equal(canView(w, memberOf(w, [])), true, 'open to everyone');
  assert.equal(canView(w, memberOf(w, [MOD])), false, 'closed by a role');
  const THIRD = '900000000000000503';
  const both = world({
    overwrites: [overwrite(MOD, { deny: F.ViewChannel }), overwrite(THIRD, { allow: F.ViewChannel })],
  });
  both.guild.roles.set(THIRD, new sdk.Role(both.guild.client, roleData(THIRD, 0n, 1), GID));
  assert.equal(canView(both, memberOf(both, [MOD, THIRD])), true, 'an allow of any role beats a deny');
  assert.equal(canView(both, memberOf(both, [MOD])), false);
});

test('the overwrite of the member themselves comes last', () => {
  const memberOverwrite = (allow, deny) => ({
    id: MEMBER,
    type: sdk.OverwriteType.Member,
    allow: String(allow),
    deny: String(deny),
  });
  const opened = world({
    overwrites: [overwrite(GID, { deny: F.ViewChannel }), memberOverwrite(F.ViewChannel, 0n)],
  });
  assert.equal(canView(opened, memberOf(opened, [])), true, 'opened for them');
  assert.equal(canView(opened, memberOf(opened, [], '900000000000000751')), false, 'not for another');
  const closed = world({
    overwrites: [overwrite(MOD, { allow: F.ViewChannel }), memberOverwrite(0n, F.ViewChannel)],
  });
  assert.equal(canView(closed, memberOf(closed, [MOD])), false, 'closed for them');
});

test('the owner and an Administrator can do everything, and a member list that holds @everyone changes nothing', () => {
  const w = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  w.guild.ownerId = MEMBER;
  assert.equal(canView(w, memberOf(w, [])), true, 'the owner');
  w.guild.ownerId = '900000000000000999';
  assert.equal(canView(w, memberOf(w, [ADMIN])), true);
  assert.equal(canView(w, memberOf(w, [GID])), false, 'a list with @everyone in it gives the same answer');
});

test('permissionsFor(member) fails closed when the member cannot be read', () => {
  const w = world({ overwrites: [overwrite(GID, { deny: F.ViewChannel })] });
  const broken = memberOf(w, []);
  Object.defineProperty(broken, 'permissions', {
    get() {
      throw new Error('boom');
    },
  });
  assert.equal(w.channel.permissionsFor(broken), null);
});

test('viewable and manageable use the same calculation for the bot own member', () => {
  // @everyone may manage channels in general, but a channel overwrite takes the view and the right away
  const closed = world({
    everyone: F.ViewChannel | F.ManageChannels,
    overwrites: [overwrite(GID, { deny: F.ViewChannel | F.ManageChannels })],
  });
  closed.guild.members.me = memberOf(closed, [], '900000000000000760');
  assert.equal(closed.channel.viewable, false, 'the SDK alone would say true');
  assert.equal(closed.channel.manageable, false);

  // a role of the bot gives them back
  const reopened = world({
    everyone: F.ViewChannel | F.ManageChannels,
    overwrites: [
      overwrite(GID, { deny: F.ViewChannel | F.ManageChannels }),
      overwrite(MOD, { allow: F.ViewChannel | F.ManageChannels }),
    ],
  });
  reopened.guild.members.me = memberOf(reopened, [MOD], '900000000000000760');
  assert.equal(reopened.channel.viewable, true);
  assert.equal(reopened.channel.manageable, true);
});
