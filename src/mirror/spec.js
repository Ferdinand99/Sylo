// What Sylo sends to Fluxer for each thing it copies, built from a Discord snapshot (snapshot.js).
//
// A spec is plain JSON. It never holds a Fluxer id: where it refers to another copied thing (a channel's
// category, a permission overwrite for a role) it holds a placeholder, "$channel:<discord id>" or
// "$role:<discord id>", and resolveSpec() swaps the placeholders for Fluxer ids at the moment of sending.
// That is what lets the preview show exactly what the copy will send (the same builders run for both), and
// it makes a spec's fingerprint independent of the ids Fluxer hands out.
//
// Every builder also returns `notes`: what could not be carried over (a permission Fluxer lacks, an overwrite
// for one member, a channel type Fluxer has no counterpart for ...). The preview lists the notes before
// anything is created; the copy stores the same notes with each item for the report.
import { createHash } from 'node:crypto';
import { FLUXER_CHANNEL, targetChannelType } from './snapshot.js';
import { ELEVATED_FLUXER_MASK, describeDropped, lostSomething, mapPermissions } from './permissions.js';

/** What the mirror copies, and whether it goes on after the first copy. All on unless the admin turns one off. */
export const DEFAULT_OPTIONS = Object.freeze({
  name: true,
  icon: true,
  banner: true,
  roles: true,
  channels: true,
  emoji: true,
  stickers: true,
  modules: true,
  continuous: true,
  // Off: a Discord delete locks the Fluxer copy instead of deleting it. On: it is deleted (only what Sylo made).
  mirrorDeletes: false,
});

/** The options as stored: only the known switches, each a boolean, the rest at their default. */
export function normaliseOptions(raw) {
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (typeof raw?.[key] === 'boolean') out[key] = raw[key];
  }
  return out;
}

/**
 * Sylo's planning limits for a Fluxer server. They decide what the preview offers; they are not read from
 * Fluxer. If Fluxer refuses an item as over its own limit while copying, the copy stops that kind and
 * the report lists the rest.
 */
export const FLUXER_LIMITS = Object.freeze({
  emoji: 500,
  stickers: 500,
  emojiBytes: 512 * 1024,
  stickerBytes: 512 * 1024,
  channelName: 100,
  roleName: 100,
  topic: 1024,
  bitrateMin: 8000,
  bitrateMax: 96000,
});

export const channelRef = (id) => `$channel:${id}`;
export const roleRef = (id) => `$role:${id}`;
const REF = /\$(channel|role):(\d{17,20})/g;
const WHOLE_REF = /^\$(channel|role):(\d{17,20})$/;

/** A fingerprint of a spec: stable for equal content whatever the key order. */
export function specHash(spec) {
  const canon = (v) =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])])
          )
        : v;
  return createHash('sha1')
    .update(JSON.stringify(canon(spec)))
    .digest('hex')
    .slice(0, 20);
}

const clip = (text, max) => String(text ?? '').slice(0, max);

const note = (code, scope, ref, message, detail = '') => ({
  code,
  scope,
  ref,
  message,
  ...(detail ? { detail } : {}),
});
const refOf = (kind, item) => ({ kind, id: item.id, name: item.name });

// --- roles ------------------------------------------------------------------------------------------

/**
 * The Fluxer role for a Discord role. The @everyone role is never created: it exists on both sides, so its
 * spec holds only the permissions (carried over together with the Fluxer-only permissions it already has).
 * @param {any} role  a role of the snapshot
 * @param {{ keep?: bigint }} [ctx]  `keep`: Fluxer-only permission bits the Fluxer role already holds
 */
export function buildRoleSpec(role, { keep = 0n } = {}) {
  const notes = [];
  const mapped = mapPermissions(role.permissions);
  if (lostSomething(mapped)) {
    notes.push(
      note(
        'permissions-dropped',
        'role',
        refOf('role', role),
        `${role.name}: Fluxer has no permission for ${describeDropped(mapped)}, so it is left off.`,
        describeDropped(mapped)
      )
    );
  }
  let bits = mapped.bits;
  if (role.isEveryone && bits & ELEVATED_FLUXER_MASK) {
    // @everyone is every member: a powerful permission there would be handed to the whole Fluxer server.
    bits &= ~ELEVATED_FLUXER_MASK;
    notes.push(
      note(
        'everyone-elevated-stripped',
        'role',
        refOf('role', role),
        '@everyone: powerful permissions (Administrator, Manage Roles and the like) are not copied onto @everyone, because they would apply to every member of the Fluxer server.'
      )
    );
  }
  const permissions = String(bits | keep);
  if (role.isEveryone) return { spec: { permissions }, notes };
  if (mapped.bits & (1n << 3n)) {
    notes.push(
      note(
        'administrator-role',
        'role',
        refOf('role', role),
        `${role.name} has Administrator, so on Fluxer it can do everything too.`
      )
    );
  }
  return {
    spec: {
      name: clip(role.name, FLUXER_LIMITS.roleName) || 'role',
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions,
    },
    notes,
  };
}

/** Why a role is not copied, or null. */
export function roleSkipReason(role) {
  if (role.isEveryone) return null;
  if (role.managed) return 'managed by an integration or a bot';
  return null;
}

// --- channels ---------------------------------------------------------------------------------------

/**
 * The Fluxer channel for a Discord channel. Returns spec null (with a note) for a type Fluxer has no
 * counterpart for.
 * @param {any} ch  a channel of the snapshot
 * @param {{ source: any, copiedRoles: Set<string> }} ctx  `copiedRoles`: the Discord role ids that are
 *   copied (an overwrite for any other role is dropped)
 */
export function buildChannelSpec(ch, { source, copiedRoles }) {
  const notes = [];
  const type = targetChannelType(ch.type);
  if (type === null) {
    notes.push(
      note(
        'channel-type-unsupported',
        'channel',
        refOf('channel', ch),
        `${ch.name}: Fluxer has no channel of this kind, so it is not copied.`
      )
    );
    return { spec: null, notes };
  }
  if (ch.type === 13) {
    notes.push(
      note(
        'stage-as-voice',
        'channel',
        refOf('channel', ch),
        `${ch.name}: Fluxer has no stage channels, so it becomes a voice channel.`
      )
    );
  }

  const overwrites = [];
  for (const o of ch.overwrites) {
    if (o.type === 'member') {
      notes.push(
        note(
          'member-overwrite-dropped',
          'channel',
          refOf('channel', ch),
          `${ch.name}: a permission overwrite for one member is not copied, because members' accounts are not linked between the servers.`
        )
      );
      continue;
    }
    const isEveryone = o.id === source.everyoneId;
    if (!isEveryone && !copiedRoles.has(o.id)) {
      const role = source.roles.find((r) => r.id === o.id);
      notes.push(
        note(
          'overwrite-role-not-copied',
          'channel',
          refOf('channel', ch),
          `${ch.name}: an overwrite for the role ${role?.name ?? o.id} is dropped, because that role is not copied.`
        )
      );
      continue;
    }
    const allow = mapPermissions(o.allow);
    const deny = mapPermissions(o.deny);
    const dropped = [...new Set([...allow.dropped, ...deny.dropped])];
    const unknown = [...new Set([...allow.unknown, ...deny.unknown])];
    if (dropped.length || unknown.length) {
      const text = describeDropped({ dropped, unknown });
      notes.push(
        note(
          'permissions-dropped',
          'channel',
          refOf('channel', ch),
          `${ch.name}: Fluxer has no permission for ${text}, so it is left off the overwrite.`,
          text
        )
      );
    }
    if (allow.bits === 0n && deny.bits === 0n) continue;
    overwrites.push({
      id: isEveryone ? '$role:everyone' : roleRef(o.id),
      type: 0,
      allow: String(allow.bits),
      deny: String(deny.bits),
    });
  }
  // Never more open than on Discord. A channel @everyone cannot see there is hidden from @everyone here, by an
  // overwrite of its own, whatever else is copied: with roles off, or while the @everyone role itself has not been
  // set yet, the channel is still private on Fluxer (where @everyone can see channels by default).
  let hide = 0n;
  if (ch.everyoneCanView === false) hide |= 1n << 10n;
  if (type === FLUXER_CHANNEL.VOICE && ch.everyoneCanConnect === false) hide |= 1n << 20n;
  if (hide) {
    const own = overwrites.find((o) => o.id === '$role:everyone');
    if (own) {
      own.deny = String(BigInt(own.deny) | hide);
      own.allow = String(BigInt(own.allow) & ~hide);
    } else {
      overwrites.push({ id: '$role:everyone', type: 0, allow: '0', deny: String(hide) });
    }
  }
  overwrites.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const spec = {
    name: clip(ch.name, FLUXER_LIMITS.channelName) || 'channel',
    type,
    parentId: ch.parentId ? channelRef(ch.parentId) : null,
    permissionOverwrites: overwrites,
  };
  if (type === FLUXER_CHANNEL.TEXT || type === FLUXER_CHANNEL.ANNOUNCEMENT) {
    spec.topic = ch.topic ? clip(ch.topic, FLUXER_LIMITS.topic) : null;
    spec.nsfw = ch.nsfw || Boolean(source.ageRestricted);
    if (type === FLUXER_CHANNEL.TEXT) spec.rateLimitPerUser = ch.rateLimitPerUser;
  } else if (type === FLUXER_CHANNEL.VOICE) {
    const bitrate =
      ch.bitrate == null
        ? null
        : Math.min(Math.max(ch.bitrate, FLUXER_LIMITS.bitrateMin), FLUXER_LIMITS.bitrateMax);
    spec.bitrate = bitrate;
    spec.userLimit = ch.userLimit ?? 0;
  } else if (type === FLUXER_CHANNEL.FORUM || type === FLUXER_CHANNEL.MEDIA) {
    spec.topic = ch.topic ? clip(ch.topic, FLUXER_LIMITS.topic) : null;
    spec.nsfw = ch.nsfw || Boolean(source.ageRestricted);
    if (ch.forum) {
      spec.availableTags = ch.forum.tags.slice(0, 20).map((t) => ({
        name: clip(t.name, 50),
        moderated: t.moderated,
        ...(t.emojiName ? { emojiName: t.emojiName } : {}),
      }));
      if (ch.forum.sortOrder != null) spec.defaultSortOrder = ch.forum.sortOrder;
      if (ch.forum.layout != null && type === FLUXER_CHANNEL.FORUM) spec.defaultForumLayout = ch.forum.layout;
      if (ch.forum.slowmode != null) spec.defaultThreadRateLimitPerUser = ch.forum.slowmode;
    }
  }
  return { spec, notes };
}

// --- emoji and stickers -------------------------------------------------------------------------------

/** An emoji name Fluxer accepts: letters, digits and underscores, at least two characters. */
export function emojiName(name) {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 32);
  return cleaned.length >= 2 ? cleaned : `${cleaned}_`.padEnd(2, '_');
}

export const buildEmojiSpec = (emoji) => ({
  spec: { name: emojiName(emoji.name), animated: emoji.animated },
  notes: [],
});

/** discord.js StickerFormatType: 3 is Lottie, an animation format Fluxer does not take. */
export function buildStickerSpec(sticker) {
  if (sticker.format === 3) {
    return {
      spec: null,
      notes: [
        note(
          'sticker-lottie',
          'sticker',
          refOf('sticker', sticker),
          `${sticker.name}: Lottie stickers cannot be copied to Fluxer.`
        ),
      ],
    };
  }
  return {
    spec: {
      name: clip(sticker.name, 30).padEnd(2, '_'),
      // Fluxer wants 1 to 500 characters or nothing.
      description: clip(sticker.description, 500) || null,
      tags: sticker.tags.slice(0, 5).map((t) => clip(t, 30)),
    },
    notes: [],
  };
}

// --- the server's own name, icon and banner ----------------------------------------------------------

export function buildIdentitySpec(source, options) {
  const spec = {};
  if (options.name) spec.name = clip(source.name, 100);
  // The URL carries the asset's hash, so a changed icon changes the fingerprint without a download.
  if (options.icon) spec.icon = source.iconUrl ?? null;
  if (options.banner) spec.banner = source.bannerUrl ?? null;
  return { spec, notes: [] };
}

// --- Sylo's own settings (module configs) ------------------------------------------------------------

const MESSAGE_ID_KEY = /message_?id$/i;
const ID = /^\d{17,20}$/;

/**
 * A module's settings with the ids of this server turned into placeholders: a channel or role id that is
 * copied becomes "$channel:<id>" / "$role:<id>" (also inside `<#id>` and `<@&id>` mentions in text); an id
 * of a channel or role that is not copied is dropped; the id of a message is cleared, because the message
 * is not copied; any other id of 17 to 20 digits (a user, a deleted item) is cleared. Short numbers stay.
 * @param {any} config
 * @param {{ channels: Set<string>, roles: Set<string>, skippedChannels: Set<string>, skippedRoles: Set<string> }} ids
 * @returns {{ config: any, remapped: number, dropped: number, cleared: number }}
 */
export function placeholderConfig(config, ids) {
  const stats = { remapped: 0, dropped: 0, cleared: 0 };
  const swap = (id) => {
    if (ids.channels.has(id)) return channelRef(id);
    if (ids.roles.has(id)) return roleRef(id);
    return null;
  };
  const isLost = (id) => ids.skippedChannels.has(id) || ids.skippedRoles.has(id);
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (MESSAGE_ID_KEY.test(key ?? '') && ID.test(value)) {
        stats.cleared += 1;
        return '';
      }
      if (ID.test(value)) {
        const ref = swap(value);
        if (ref) {
          stats.remapped += 1;
          return ref;
        }
        if (isLost(value)) {
          stats.dropped += 1;
          return undefined;
        }
        // A user id, the id of something deleted, a number only Discord knows: meaningless on Fluxer.
        stats.cleared += 1;
        return undefined;
      }
      return value.replace(/<(#|@&)(\d{17,20})>/g, (all, sigil, id) => {
        const ref = swap(id);
        if (ref) {
          stats.remapped += 1;
          return `<${sigil}${ref}>`;
        }
        if (isLost(id)) {
          stats.dropped += 1;
          return '';
        }
        return all;
      });
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key)).filter((v) => v !== undefined);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const next = walk(v, k);
        out[k] = next === undefined ? '' : next;
      }
      return out;
    }
    return value;
  };
  return { config: walk(config, ''), ...stats };
}

// --- placeholders -------------------------------------------------------------------------------------

/** The placeholders a value contains, as "channel:<id>" / "role:<id>". */
export function refsIn(value) {
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(REF)) found.add(`${m[1]}:${m[2]}`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return [...found];
}

/**
 * Swap the placeholders of a spec for Fluxer ids. `lookup('channel' | 'role', discordId)` gives the Fluxer id or
 * null. A placeholder that stands alone and cannot be resolved becomes null (or leaves its array); one inside
 * a text is removed.
 * @returns {{ value: any, unresolved: string[] }}
 */
export function resolveSpec(spec, lookup) {
  const unresolved = [];
  const find = (kind, id) => {
    if (kind === 'role' && id === 'everyone') return lookup('role', 'everyone');
    const found = lookup(kind, id);
    if (!found) unresolved.push(`${kind}:${id}`);
    return found;
  };
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = WHOLE_REF.exec(v) ?? /^\$(role):(everyone)$/.exec(v);
      if (whole) return find(whole[1], whole[2]) ?? undefined;
      return v.replace(/\$(channel|role):(\d{17,20})/g, (_all, kind, id) => find(kind, id) ?? '');
    }
    if (Array.isArray(v)) return v.map(walk).filter((x) => x !== undefined);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const next = walk(x);
        out[k] = next === undefined ? null : next;
      }
      return out;
    }
    return v;
  };
  return { value: walk(spec), unresolved };
}
