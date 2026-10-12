// discord.js-shaped aliases on the Fluxer SDK's classes.
//
// Sylo's command and module code was written against discord.js. The Fluxer SDK
// is modelled on it but differs in places (no `createdTimestamp`, no `user.tag`,
// bans through `guild.ban()`, overwrite edits that replace instead of merge, …).
// Rather than touch hundreds of call sites, each gap is bridged here with a thin
// alias over the SDK's own API. Add an alias when a real run needs it, with a
// test against the real class (test/fluxerCompat*.test.js) — never speculatively.
//
// The SDK is passed in (see fluxerBot.js), so mainline never imports it for a
// Discord-only install. Installing is idempotent, and an alias never replaces a
// member the SDK already has.

import { fluxerEndpoints } from './instance.js';

const WRAPPED = Symbol.for('sylo.fluxerCompat');
const idOf = (x) => (typeof x === 'string' ? x : x?.id);

// Bulk delete skips anything older than this (discord.js's filterOld), less a
// minute of slack so a message on the edge doesn't fail the whole request.
const BULK_DELETE_MAX_AGE_MS = 14 * 86_400_000 - 60_000;

/** Define a getter/method on a prototype unless the SDK already has one. */
function define(proto, name, descriptor) {
  if (name in proto) return;
  Object.defineProperty(proto, name, { configurable: true, enumerable: false, ...descriptor });
}
const getter = (fn) => ({ get: fn });
const method = (fn) => ({ value: fn, writable: true });

/** Replace proto[name] with make(native), once. */
function wrap(proto, name, make) {
  const native = proto[name];
  if (typeof native !== 'function')
    throw new TypeError(`compat: ${proto.constructor?.name}.${name} is missing`);
  if (native[WRAPPED]) return;
  const wrapped = make(native);
  wrapped[WRAPPED] = true;
  proto[name] = wrapped;
}

// --- overwrites ---------------------------------------------------------------

/** True when `opts` is the discord.js `{ FlagName: true | false | null }` form. */
const isLegacyOverwrite = (opts) =>
  Boolean(opts) && typeof opts === 'object' && !('allow' in opts) && !('deny' in opts) && !('type' in opts);

/**
 * Merge a discord.js tri-state overwrite edit onto the existing allow/deny
 * bits: true → allow, false → deny, null → inherit (clear both).
 * @param {bigint | number | undefined} existingAllow
 * @param {bigint | number | undefined} existingDeny
 * @param {Record<string, boolean | null>} changes
 * @param {Record<string, bigint>} flags  the SDK's PermissionFlags
 */
export function mergeLegacyOverwrite(existingAllow, existingDeny, changes, flags) {
  let allow = BigInt(existingAllow ?? 0);
  let deny = BigInt(existingDeny ?? 0);
  for (const [name, value] of Object.entries(changes)) {
    const bit = flags[name];
    if (bit === undefined) continue; // a permission this platform does not have (e.g. thread permissions)
    allow &= ~bit;
    deny &= ~bit;
    if (value === true) allow |= bit;
    else if (value === false) deny |= bit;
  }
  return { allow, deny };
}

// --- REST messages and guild_id -------------------------------------------------

/** The guild a channel belongs to, from the client's caches. */
function guildIdOfChannel(client, channelId) {
  const cached = client?.channels.get(channelId)?.guildId;
  if (cached) return cached;
  for (const guild of client?.guilds.values() ?? []) if (guild.channels?.has(channelId)) return guild.id;
  return null;
}

/** Give REST-fetched message(s) their guild id. Accepts a message, an array or a Map; returns its input. */
export function withGuildId(client, value) {
  const fill = (m) => {
    if (m && m.guildId == null && m.channelId) {
      const gid = guildIdOfChannel(client, m.channelId);
      if (gid) m.guildId = gid;
    }
  };
  if (value instanceof Map) for (const m of value.values()) fill(m);
  else if (Array.isArray(value)) value.forEach(fill);
  else fill(value);
  return value;
}

/**
 * @param {Record<string, any>} sdk  the @fluxerjs/core module
 * @param {{ Collection?: new (entries?: Iterable<[string, any]>) => Map<string, any>, voice?: ReturnType<typeof import('./voiceStates.js').createVoiceTracker> }} [deps]
 *   `voice` is the process's voice-state tracker; without it member.voice, guild.voiceStates and channel.members are not installed.
 */
export function installFluxerCompat(sdk, { Collection, voice } = {}) {
  const {
    Channel,
    ChannelManager,
    EmbedBuilder,
    Guild,
    GuildBan,
    GuildChannel,
    GuildEmoji,
    GuildMember,
    GuildMemberManager,
    GuildMemberRoleManager,
    Invite,
    Message,
    MessageManager,
    MessageReaction,
    MessageReactionManager,
    OverwriteType,
    PartialMessage,
    PermissionsBitField,
    PermissionOverwriteManager,
    Role,
    User,
  } = sdk;
  const flags = sdk.PermissionFlags;

  // Collection: discord.js has hasAny / hasAll.
  if (Collection) {
    define(
      Collection.prototype,
      'hasAny',
      method(function (...keys) {
        return keys.flat().some((k) => this.has(k));
      })
    );
    define(
      Collection.prototype,
      'hasAll',
      method(function (...keys) {
        return keys.flat().every((k) => this.has(k));
      })
    );
  }

  // EmbedBuilder: discord.js takes addFields(a, b) and addFields([a, b]); Fluxer's
  // only takes the spread form and crashes on an array.
  wrap(
    EmbedBuilder.prototype,
    'addFields',
    (native) =>
      function (...fields) {
        return native.apply(this, fields.flat());
      }
  );

  // The SDK shares one User object per id and overwrites its name on every payload that
  // mentions the user. A ban event carries only the id, so it wipes the name of a cached
  // user ("undefined" in every embed afterwards); a payload without one adds nothing.
  wrap(
    User.prototype,
    '_patch',
    (native) =>
      function (data) {
        if (data?.username === undefined) return;
        return native.call(this, data);
      }
  );

  // User: discord.js `tag` (username, plus #discriminator when there is one).
  define(
    User.prototype,
    'tag',
    getter(function () {
      const d = this.discriminator;
      return d && d !== '0' && d !== '0000' ? `${this.username}#${d}` : this.username;
    })
  );

  // Message timestamps: epoch ms, as in discord.js.
  define(
    Message.prototype,
    'createdTimestamp',
    getter(function () {
      return this.createdAt?.getTime() ?? null;
    })
  );
  define(
    Message.prototype,
    'editedTimestamp',
    getter(function () {
      return this.editedAt?.getTime() ?? null;
    })
  );

  // Guild ---------------------------------------------------------------------
  for (const [name, key] of [
    ['systemChannel', 'systemChannelId'],
    ['rulesChannel', 'rulesChannelId'],
    ['afkChannel', 'afkChannelId'],
  ]) {
    define(
      Guild.prototype,
      name,
      getter(function () {
        return this[key] ? (this.channels.get(this[key]) ?? null) : null;
      })
    );
  }
  define(
    Guild.prototype,
    'fetchVanityData',
    method(function () {
      return this.fetchVanityURL();
    })
  );
  define(
    Guild.prototype,
    'bans',
    getter(function () {
      const guild = this;
      return {
        create: (user, opts = {}) => guild.ban(idOf(user), opts),
        remove: (user, reason) => guild.unban(idOf(user), reason),
        fetch: async (arg) => {
          const bans = await guild.fetchBans();
          const id = typeof arg === 'string' ? arg : (arg?.user ?? null);
          if (id) {
            const hit = bans.find((b) => (b.user?.id ?? b.userId) === idOf(id));
            if (!hit) throw Object.assign(new Error('Unknown Ban'), { code: 10026 });
            // The API lists a ban with only the user's id; discord.js callers expect a name.
            if (hit.user && hit.user.username === undefined)
              await guild.client.users.fetch(hit.user.id, { force: true }).catch(() => null);
            return hit;
          }
          return new Collection(bans.map((b) => [b.user?.id ?? b.userId, b]));
        },
      };
    })
  );
  define(
    Guild.prototype,
    'invites',
    getter(function () {
      const guild = this;
      return { fetch: async () => new Collection((await guild.fetchInvites()).map((i) => [i.code, i])) };
    })
  );

  // Channels ------------------------------------------------------------------
  define(
    GuildChannel.prototype,
    'guild',
    getter(function () {
      return this.guildId ? (this.client.guilds.get(this.guildId) ?? null) : null;
    })
  );
  define(
    GuildChannel.prototype,
    'permissionsFor',
    method(function (target) {
      if (!target) return null;
      const member =
        typeof target?.permissionsIn === 'function' ? target : this.guild?.members.get(idOf(target));
      return member ? member.permissionsIn(this) : null;
    })
  );
  define(
    GuildChannel.prototype,
    'rawPosition',
    getter(function () {
      return this.position ?? 0;
    })
  );
  // discord.js permission shortcuts for what the bot itself may do. Fluxer's
  // classes have none, so code like `if (!channel.manageable) continue` would
  // silently never act.
  const botPermsIn = (channel) => {
    const me = channel?.guild?.members.me;
    return me && channel ? me.permissionsIn(channel) : null;
  };
  define(
    GuildChannel.prototype,
    'viewable',
    getter(function () {
      return Boolean(botPermsIn(this)?.has('ViewChannel'));
    })
  );
  define(
    GuildChannel.prototype,
    'manageable',
    getter(function () {
      const perms = botPermsIn(this);
      return Boolean(perms?.has('ViewChannel') && perms.has('ManageChannels'));
    })
  );
  define(
    GuildChannel.prototype,
    'deletable',
    getter(function () {
      return this.manageable;
    })
  );
  define(
    GuildChannel.prototype,
    'setName',
    method(function (name, reason) {
      return this.edit({ name, reason });
    })
  );
  define(
    GuildChannel.prototype,
    'setRateLimitPerUser',
    method(function (seconds, reason) {
      return this.edit({ rateLimitPerUser: seconds, reason });
    })
  );
  define(
    GuildChannel.prototype,
    'setUserLimit',
    method(function (userLimit, reason) {
      return this.edit({ userLimit, reason });
    })
  );

  // Overwrites: accept a Role/Member object as the target, and translate the
  // discord.js tri-state `{ Flag: bool | null }` form onto Fluxer's replace-style
  // `{ type, allow, deny }`.
  const overwriteTypeFor = (channel, id) =>
    id === channel.guildId || channel.guild?.roles.get(id) ? OverwriteType.Role : OverwriteType.Member;
  wrap(
    PermissionOverwriteManager.prototype,
    'edit',
    (native) =>
      function (target, opts) {
        const id = idOf(target);
        if (!isLegacyOverwrite(opts)) return native.call(this, id, opts);
        const existing = this.cache.get(id);
        const { allow, deny } = mergeLegacyOverwrite(existing?._allow, existing?._deny, opts, flags);
        return native.call(this, id, {
          type: existing?.type ?? overwriteTypeFor(this.channel, id),
          allow,
          deny,
        });
      }
  );
  wrap(
    PermissionOverwriteManager.prototype,
    'delete',
    (native) =>
      function (target) {
        return native.call(this, idOf(target));
      }
  );

  // Channel.bulkDelete: discord.js takes a count, or a Collection / array of
  // messages or ids, plus `filterOld` to skip messages older than 14 days, and
  // resolves to a Collection of what it deleted. Fluxer's takes a count or an
  // array of ids and resolves to an id array.
  wrap(
    Channel.prototype,
    'bulkDelete',
    (native) =>
      async function (messages, filterOld = false) {
        if (typeof messages === 'number') {
          const ids = await native.call(this, messages);
          return new Collection(ids.map((id) => [id, { id }]));
        }
        const list = messages instanceof Map ? [...messages.values()] : [...(messages ?? [])];
        let entries = list.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m?.id);
        if (filterOld) {
          const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
          entries = entries.filter((m) => m.createdTimestamp == null || m.createdTimestamp > cutoff);
        }
        const ids = entries.length
          ? await native.call(
              this,
              entries.map((m) => m.id)
            )
          : [];
        const byId = new Map(entries.map((m) => [m.id, m]));
        return new Collection(ids.map((id) => [id, byId.get(id) ?? { id }]));
      }
  );

  // Members -------------------------------------------------------------------
  // discord.js fetch() forms: no args = every member (Collection); { user: ids }
  // = those members (Collection). Fluxer's native fetch(options) returns one
  // page as an array and has no bulk-by-id lookup.
  wrap(
    GuildMemberManager.prototype,
    'fetch',
    (native) =>
      async function (arg, options) {
        if (typeof arg === 'string') return native.call(this, arg, options);
        if (arg && typeof arg.user === 'string') return native.call(this, arg.user, arg);
        if (arg && Array.isArray(arg.user)) {
          const out = new Collection();
          const ids = [...new Set(arg.user.map(idOf))];
          for (let i = 0; i < ids.length; i += 5) {
            const batch = await Promise.all(
              ids.slice(i, i + 5).map((id) => native.call(this, id).catch(() => null))
            );
            for (const m of batch) if (m) out.set(m.id, m);
          }
          return out;
        }
        if (arg && (arg.limit != null || arg.after)) return native.call(this, arg);
        const out = new Collection();
        let after;
        for (let page = 0; page < 200; page++) {
          const members = await native.call(this, { limit: 1000, after });
          for (const m of members) out.set(m.id, m);
          if (members.length < 1000) break;
          after = members[members.length - 1].id;
        }
        return out;
      }
  );
  // Can the bot change this member (nickname, roles)? Not the owner, not itself,
  // and ranked strictly below the bot's highest role.
  define(
    GuildMember.prototype,
    'manageable',
    getter(function () {
      const guild = this.guild;
      const me = guild?.members.me;
      if (!me || this.id === guild.ownerId) return false;
      if (this.id === me.id) return false;
      if (guild.ownerId === me.id) return true;
      return (me.roles.highest?.position ?? 0) > (this.roles.highest?.position ?? 0);
    })
  );
  define(
    GuildMember.prototype,
    'nickname',
    getter(function () {
      return this.nick ?? null;
    })
  );
  define(
    GuildMember.prototype,
    'setNickname',
    method(function (nick, reason) {
      return this.edit({ nick, reason });
    })
  );
  // discord.js member.send() DMs the member; on Fluxer only User has send.
  define(
    GuildMember.prototype,
    'send',
    method(function (options) {
      return this.user.send(options);
    })
  );
  define(
    GuildMember.prototype,
    'communicationDisabledUntilTimestamp',
    getter(function () {
      return this.communicationDisabledUntil ? this.communicationDisabledUntil.getTime() : null;
    })
  );
  define(
    GuildMember.prototype,
    'isCommunicationDisabled',
    method(function () {
      return Boolean(
        this.communicationDisabledUntil && this.communicationDisabledUntil.getTime() > Date.now()
      );
    })
  );
  // discord.js add/remove take one role or many, plus an optional reason.
  wrap(
    GuildMemberRoleManager.prototype,
    'add',
    (native) =>
      async function (roles) {
        for (const r of [].concat(roles).flat()) await native.call(this, idOf(r));
        return this.member;
      }
  );
  wrap(
    GuildMemberRoleManager.prototype,
    'remove',
    (native) =>
      async function (roles) {
        for (const r of [].concat(roles).flat()) await native.call(this, idOf(r));
        return this.member;
      }
  );
  define(
    GuildMemberRoleManager.prototype,
    'highest',
    getter(function () {
      const roles = [...this.cache.values()];
      const everyone = this.member?.guild?.roles.everyone ?? null;
      return roles.reduce((top, r) => (!top || r.position > top.position ? r : top), null) ?? everyone;
    })
  );

  // Roles, emojis, bans, invites ----------------------------------------------
  define(
    Role.prototype,
    'hexColor',
    getter(function () {
      return `#${(this.color ?? 0).toString(16).padStart(6, '0')}`;
    })
  );
  // discord.js role.members: the cached members holding this role. Like there,
  // it only covers the member cache — fetch members first for a full list.
  define(
    Role.prototype,
    'members',
    getter(function () {
      const members = this.guild?.members;
      if (!members) return new Collection();
      return new Collection(
        [...members.values()].filter((m) => m.roles.cache.has(this.id)).map((m) => [m.id, m])
      );
    })
  );
  define(
    Role.prototype,
    'comparePositionTo',
    method(function (other) {
      const o = typeof other === 'string' ? this.client.guilds.get(this.guildId)?.roles.get(other) : other;
      return this.position - (o?.position ?? 0);
    })
  );
  define(
    Role.prototype,
    'guild',
    getter(function () {
      return this.client.guilds.get(this.guildId) ?? null;
    })
  );
  // Can the bot assign / remove this role? (Manage Roles, and ranked above it.)
  define(
    Role.prototype,
    'editable',
    getter(function () {
      const guild = this.client.guilds.get(this.guildId);
      const me = guild?.members.me;
      if (!me || this.id === this.guildId) return false;
      if (guild.ownerId === me.id) return true;
      if (!me.permissions.has('ManageRoles')) return false;
      return (me.roles.highest?.position ?? 0) > this.position;
    })
  );
  define(
    Role.prototype,
    'managed',
    getter(() => false)
  );
  define(
    GuildEmoji.prototype,
    'imageURL',
    method(function () {
      return this.url;
    })
  );
  // discord.js exposes the guild object on bans and invites.
  define(
    GuildBan.prototype,
    'guild',
    getter(function () {
      return this.client.guilds.get(this.guildId) ?? null;
    })
  );
  define(
    Invite.prototype,
    'guild',
    getter(function () {
      const id = this.guildSnapshot?.id;
      return id ? (this.client.guilds.get(id) ?? null) : null;
    })
  );

  // Messages & reactions ------------------------------------------------------
  // Fluxer's REST message payloads (GET /channels/:id/messages…) omit `guild_id`,
  // so a fetched Message has `guildId === null` and message.guild / message.member
  // come back null even in a guild channel. Fill it in from the channel.
  for (const [proto, name] of [
    [MessageManager.prototype, 'fetch'],
    [ChannelManager.prototype, 'fetchMessage'],
    [MessageReaction.prototype, 'fetchMessage'],
    [Message.prototype, 'fetch'],
    [PartialMessage.prototype, 'fetch'],
  ]) {
    wrap(
      proto,
      name,
      (native) =>
        async function (...args) {
          return withGuildId(this.client, await native.apply(this, args));
        }
    );
  }
  // channel.messages.delete(id): Fluxer deletes through the Message itself.
  define(
    MessageManager.prototype,
    'delete',
    method(async function (message) {
      const msg = typeof message === 'string' ? await this.fetch(message) : message;
      return msg.delete();
    })
  );
  define(
    Message.prototype,
    'inGuild',
    method(function () {
      return Boolean(this.guildId);
    })
  );
  define(
    Message.prototype,
    'url',
    getter(function () {
      const base = this.client.instance?.endpoints?.webapp ?? fluxerEndpoints().webapp;
      return `${base}/channels/${this.guildId ?? '@me'}/${this.channelId}/${this.id}`;
    })
  );
  // The bot may delete its own messages anywhere, and others' with Manage Messages.
  define(
    Message.prototype,
    'deletable',
    getter(function () {
      if (this.author?.id && this.author.id === this.client.user?.id) return true;
      const channel = this.channel ?? this.client.channels.get(this.channelId);
      return Boolean(channel?.guildId && botPermsIn(channel)?.has('ManageMessages'));
    })
  );
  define(
    Message.prototype,
    'editable',
    getter(function () {
      return Boolean(this.author?.id && this.author.id === this.client.user?.id);
    })
  );
  define(
    MessageReactionManager.prototype,
    'removeAll',
    method(async function () {
      const ctx = this.message;
      const msg = await ctx.client.channels.fetchMessage(ctx.channelId, ctx.id);
      return msg.removeAllReactions();
    })
  );
  define(
    MessageReaction.prototype,
    'partial',
    getter(() => false)
  );
  define(
    MessageReaction.prototype,
    'fetch',
    method(async function () {
      return this;
    })
  );
  // Remove every reaction with this emoji from the message.
  define(
    MessageReaction.prototype,
    'remove',
    method(async function () {
      const msg = this.message ?? (await this.fetchMessage());
      return msg.removeReactionEmoji(this.emojiIdentifier);
    })
  );
  define(
    MessageReaction.prototype,
    'users',
    getter(function () {
      const reaction = this;
      const emoji = reaction.emojiIdentifier;
      const load = () => reaction.message ?? reaction.fetchMessage();
      return {
        fetch: async () => {
          const msg = await load();
          const users = [];
          let after;
          for (let page = 0; page < 20; page++) {
            const res = await msg.fetchReactionUsersPage(emoji, { limit: 100, after });
            users.push(...res.users);
            if (!res.hasMore || !res.nextAfter) break;
            after = res.nextAfter;
          }
          return new Collection(users.map((u) => [u.id, u]));
        },
        remove: async (user) => (await load()).removeReaction(emoji, idOf(user)),
      };
    })
  );

  // Guild.channels is a plain Collection on Fluxer, which has no fetch(); resolve from the cache.
  if (Collection) {
    define(
      Collection.prototype,
      'fetch',
      method(async function (id) {
        return this.get(id) ?? null;
      })
    );
  }

  // Fluxer has no boost tiers; this is the platform's bitrate ceiling.
  define(
    Guild.prototype,
    'maximumBitrate',
    getter(() => 384_000)
  );

  // channel.create() from discord.js-style options (parent, permissionOverwrites with
  // permission names or bits) onto Fluxer's createChannel().
  define(
    Guild.prototype,
    'createChannelCompat',
    method(function (opts) {
      const toOverwrite = (o) => ({
        id: o.id,
        type:
          o.type ?? (o.id === this.id || this.roles.get(o.id) ? OverwriteType.Role : OverwriteType.Member),
        allow: new PermissionsBitField(o.allow ?? 0n).bitfield,
        deny: new PermissionsBitField(o.deny ?? 0n).bitfield,
      });
      const { name, type, topic, userLimit, bitrate, rateLimitPerUser, nsfw, reason } = opts;
      return this.createChannel({
        name,
        type,
        parentId: idOf(opts.parent) ?? opts.parentId ?? null,
        topic,
        userLimit,
        bitrate,
        rateLimitPerUser,
        nsfw,
        ...(reason !== undefined && { reason }),
        permissionOverwrites: (opts.permissionOverwrites ?? []).map(toOverwrite),
      });
    })
  );

  // Voice: Fluxer members carry no voice state, so these read the tracker.
  if (voice) {
    define(
      GuildMember.prototype,
      'voice',
      getter(function () {
        const member = this;
        const state = voice.statesFor(member.guild.id).get(member.id) ?? null;
        return {
          channelId: state?.channelId ?? null,
          get channel() {
            return state?.channel ?? null;
          },
          selfDeaf: state?.selfDeaf ?? false,
          selfMute: state?.selfMute ?? false,
          deaf: state?.deaf ?? false,
          mute: state?.mute ?? false,
          // Fluxer supports several connections per user: move the one being tracked.
          setChannel: (channel) => member.move(idOf(channel), state?.connectionId ?? undefined),
          disconnect: () => member.move(null, state?.connectionId ?? undefined),
        };
      })
    );
    define(
      Guild.prototype,
      'voiceStates',
      getter(function () {
        return { cache: voice.statesFor(this.id) };
      })
    );
    define(
      GuildChannel.prototype,
      'members',
      getter(function () {
        return voice.membersIn(this.guildId, this.id);
      })
    );
  }
}
