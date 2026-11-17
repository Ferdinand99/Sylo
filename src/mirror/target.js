// The Fluxer side of the mirror: everything the engine does to the Fluxer server goes through this one
// object, so the engine never touches the SDK itself and a test can hand it a fake with the same methods.
//
// Each method takes a spec from spec.js with its placeholders already resolved to Fluxer ids, and returns
// the id of what it made. An SDK error is thrown as is; the engine classifies it (errors.js).
//
// `me` is the Fluxer server's own Sylo member: the engine checks its permissions before anything is created
// and clamps role positions under Sylo's own highest role.
import { FLUXER_LIMITS } from './spec.js';
import { isNotFound } from './errors.js';

const get = (collection, id) => collection?.get?.(id) ?? collection?.cache?.get?.(id) ?? null;
const list = (collection) => [...(collection?.values?.() ?? collection?.cache?.values?.() ?? [])];

const bits = (value) => BigInt(value ?? 0);

/** The permissions Sylo needs on the Fluxer server for a mirror. Administrator covers all of them. */
export const NEEDED_PERMISSIONS = Object.freeze([
  'ManageChannels',
  'ManageRoles',
  'ManageExpressions',
  'ManageGuild',
]);

/**
 * Fluxer ranks roles by position, highest first, and by id (the older, smaller one first) when positions are equal;
 * every role starts at position 1 and positions are only renumbered when someone reorders. So a position number says
 * nothing by itself: what counts is the rank. The roles of `roles` that rank above `sylo` (not `ignore`d, not Sylo's
 * own), in rank order.
 * @param {{ id: string, position: number }} sylo  Sylo's highest role
 * @param {Array<{ id: string, name: string, position: number }>} roles
 * @param {Set<string>} ignore
 */
export function rolesAbove(sylo, roles, ignore = new Set()) {
  const outranks = (a, b) =>
    a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id));
  return roles
    .filter((r) => r.id !== sylo.id && !ignore.has(r.id) && outranks(r, sylo))
    .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** @param {{ mime: string, bytes: Buffer }} image */
export const toDataUri = (image) => `data:${image.mime};base64,${image.bytes.toString('base64')}`;

/**
 * @param {any} guild  a Fluxer SDK Guild
 */
export function createFluxerTarget(guild) {
  const overwrites = (spec) =>
    (spec.permissionOverwrites ?? []).map((o) => ({
      id: o.id,
      type: o.type,
      allow: bits(o.allow),
      deny: bits(o.deny),
    }));

  const channelBody = (spec) => ({
    ...spec,
    ...(spec.permissionOverwrites ? { permissionOverwrites: overwrites(spec) } : {}),
  });

  // The cached item, else a look-up on Fluxer. Only a real "not found" answer is null (and so "gone"): a failed
  // look-up (a timeout, a 429, a 5xx) is thrown, so the engine retries it instead of making a second copy.
  const find = async (cached, lookup, what) => {
    if (cached) return cached;
    if (typeof lookup !== 'function') throw new Error(`The ${what} could not be looked up.`);
    try {
      return (await lookup()) ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  };
  const channelOf = (id) =>
    find(
      get(guild.channels, id),
      guild.client?.channels?.fetch && (() => guild.client.channels.fetch(id)),
      'channel'
    );
  const roleOf = (id) => find(get(guild.roles, id), guild.fetchRole && (() => guild.fetchRole(id)), 'role');
  const emojiOf = (id) =>
    find(get(guild.emojis, id), guild.fetchEmoji && (() => guild.fetchEmoji(id)), 'emoji');
  const stickerOf = (id) =>
    find(get(guild.stickers, id), guild.fetchSticker && (() => guild.fetchSticker(id)), 'sticker');

  const gone = () => Object.assign(new Error('Unknown channel or role'), { statusCode: 404 });

  // The SDK's REST client, for the routes whose SDK method does not fit Fluxer's answer.
  const rest = () => {
    const client = guild.client?.rest;
    if (typeof client?.patch !== 'function') throw new Error('The Fluxer REST client is not available.');
    return client;
  };

  return {
    kind: 'fluxer',
    id: String(guild.id),
    name: String(guild.name ?? ''),
    limits: () => FLUXER_LIMITS,

    /** The permissions of Sylo's role on the server that the mirror needs and Sylo lacks. */
    missingPermissions() {
      const perms = guild.members?.me?.permissions;
      if (!perms || typeof perms.has !== 'function') return [];
      if (perms.has('Administrator')) return [];
      return NEEDED_PERMISSIONS.filter((p) => !perms.has(p));
    },
    /**
     * The roles on the Fluxer server that rank above Sylo's own (see rolesAbove), apart from `ignore` (the ids of roles
     * the mirror made itself: they are ordered under Sylo). Null when Sylo's own role is not known.
     */
    rolesAboveSylo(ignore = []) {
      const highest = guild.members?.me?.roles?.highest;
      if (!highest?.id) return null;
      const roles = list(guild.roles).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ''),
        position: Number(r.position ?? 0),
      }));
      return rolesAbove(
        { id: String(highest.id), position: Number(highest.position ?? 0) },
        roles,
        new Set([guild.id, ...ignore])
      );
    },

    // --- what is there now (for adoption after a crash, and the preview's counts) ---
    listChannels: () =>
      list(guild.channels).map((c) => ({
        id: String(c.id),
        name: String(c.name ?? ''),
        type: c.type,
        parentId: c.parentId ? String(c.parentId) : null,
      })),
    listRoles: () =>
      list(guild.roles).map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ''),
        managed: Boolean(r.managed),
        position: Number(r.position ?? 0),
      })),
    listEmojis: () => list(guild.emojis).map((e) => ({ id: String(e.id), name: String(e.name ?? '') })),
    listStickers: () => list(guild.stickers).map((e) => ({ id: String(e.id), name: String(e.name ?? '') })),

    // --- the server itself ---
    async editGuild({ name, icon, banner }) {
      const body = {};
      if (name !== undefined) body.name = name;
      if (icon !== undefined) body.icon = icon;
      if (banner !== undefined) body.banner = banner;
      await guild.edit(body);
    },

    // --- roles ---
    async createRole(spec) {
      const role = await guild.createRole({
        name: spec.name,
        permissions: bits(spec.permissions),
        color: spec.color,
      });
      // Hoisting and mentionability cannot be set when a role is made. If this second call fails the role exists:
      // the error carries its id, so the engine tracks it and the retry updates it instead of making another.
      if (spec.hoist || spec.mentionable) {
        try {
          await role.edit({ hoist: spec.hoist, mentionable: spec.mentionable });
        } catch (err) {
          err.createdId = String(role.id);
          throw err;
        }
      }
      return String(role.id);
    },
    async editRole(id, spec) {
      const role = await roleOf(id);
      if (!role) throw gone();
      const body = { permissions: bits(spec.permissions) };
      if (spec.name !== undefined)
        Object.assign(body, {
          name: spec.name,
          color: spec.color,
          hoist: spec.hoist,
          mentionable: spec.mentionable,
        });
      await role.edit(body);
    },
    async deleteRole(id) {
      const role = await roleOf(id);
      if (!role) throw gone();
      await role.delete('Mirrored from the Discord server');
    },
    /**
     * PATCH /guilds/{id}/roles with `[{ id, position }]`. Fluxer answers 204 No Content; the SDK's
     * guild.setRolePositions() maps over the answer as if it were the role list (Discord's answer) and throws on it
     * after the order was set, so the route is called through the SDK's REST client instead. The new positions reach
     * the role cache through the gateway (GUILD_ROLE_UPDATE_BULK).
     * @param {Array<{ id: string, position: number }>} updates
     */
    async setRolePositions(updates) {
      await rest().patch(`/guilds/${guild.id}/roles`, {
        body: updates.map((u) => ({ id: String(u.id), position: Number(u.position) })),
        auth: true,
      });
    },

    // --- channels ---
    async createChannel(spec) {
      const channel = await guild.createChannel(channelBody(spec));
      return String(channel.id);
    },
    async editChannel(id, spec) {
      const channel = await channelOf(id);
      if (!channel) throw gone();
      const { type, ...body } = channelBody(spec);
      // Only a text channel and an announcement channel can change into each other.
      const textual = (t) => t === 0 || t === 5;
      await channel.edit(textual(type) && textual(channel.type) ? { type, ...body } : body);
    },
    async deleteChannel(id) {
      const channel = await channelOf(id);
      if (!channel) throw gone();
      await channel.delete({ reason: 'Mirrored from the Discord server' });
    },
    /**
     * PATCH /guilds/{id}/channels with `[{ id, position, parent_id, lock_permissions }]` (Fluxer answers 204). Fluxer
     * applies the items one by one, in the order sent: `position` is the index among the channel's new siblings at
     * that moment, and a move that leaves a voice channel above a text channel in a category is refused (400). The
     * engine sends them in an order that keeps every step valid (see channelPositionUpdates in plan.js).
     * @param {Array<{ id: string, position: number, parentId: string | null }>} updates
     */
    async setChannelPositions(updates) {
      await rest().patch(`/guilds/${guild.id}/channels`, {
        body: updates.map((u) => ({
          id: String(u.id),
          position: Number(u.position),
          parent_id: u.parentId == null ? null : String(u.parentId),
          lock_permissions: false,
        })),
        auth: true,
      });
    },

    // --- emoji and stickers ---
    async createEmoji({ name, image }) {
      return String((await guild.createEmoji({ name, image: toDataUri(image) })).id);
    },
    async editEmoji(id, { name }) {
      const emoji = await emojiOf(id);
      if (!emoji) throw gone();
      await emoji.edit({ name });
    },
    async deleteEmoji(id) {
      const emoji = await emojiOf(id);
      if (!emoji) throw gone();
      await emoji.delete('Mirrored from the Discord server');
    },
    async createSticker({ name, description, tags, image }) {
      return String((await guild.createSticker({ name, description, tags, image: toDataUri(image) })).id);
    },
    async editSticker(id, { name, description, tags }) {
      const sticker = await stickerOf(id);
      if (!sticker) throw gone();
      await sticker.edit({ name, description, tags });
    },
    async deleteSticker(id) {
      const sticker = await stickerOf(id);
      if (!sticker) throw gone();
      await sticker.delete('Mirrored from the Discord server');
    },
  };
}
