// Reading a Discord server into plain data, and the same for the Fluxer server it is copied to. The engine
// and the preview work on these snapshots, never on the SDK objects, so what the preview shows is exactly
// what the copy then reads, and tests can build a server from plain objects.

/** discord.js ChannelType numbers that a mirror understands. */
export const DISCORD_CHANNEL = Object.freeze({
  TEXT: 0,
  VOICE: 2,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  STAGE: 13,
  FORUM: 15,
  MEDIA: 16,
});

/** Fluxer ChannelType numbers. */
export const FLUXER_CHANNEL = Object.freeze({
  TEXT: 0,
  VOICE: 2,
  CATEGORY: 4,
  ANNOUNCEMENT: 5,
  FORUM: 15,
  MEDIA: 16,
});

/**
 * The Fluxer channel type a Discord channel type becomes, or null when it has no counterpart. A stage
 * channel becomes a voice channel (Fluxer has no stages); threads and directories are not copied.
 */
export function targetChannelType(discordType) {
  switch (discordType) {
    case DISCORD_CHANNEL.TEXT:
      return FLUXER_CHANNEL.TEXT;
    case DISCORD_CHANNEL.VOICE:
    case DISCORD_CHANNEL.STAGE:
      return FLUXER_CHANNEL.VOICE;
    case DISCORD_CHANNEL.CATEGORY:
      return FLUXER_CHANNEL.CATEGORY;
    case DISCORD_CHANNEL.ANNOUNCEMENT:
      return FLUXER_CHANNEL.ANNOUNCEMENT;
    case DISCORD_CHANNEL.FORUM:
      return FLUXER_CHANNEL.FORUM;
    case DISCORD_CHANNEL.MEDIA:
      return FLUXER_CHANNEL.MEDIA;
    default:
      return null;
  }
}

const values = (collection) => [...(collection?.values?.() ?? [])];
const big = (v) => {
  try {
    return BigInt(v?.bitfield ?? v ?? 0);
  } catch {
    return 0n;
  }
};

/** Whether a role-or-member overwrite is for a role. discord.js: type 0 or 'role' is a role. */
const isRoleOverwrite = (o) => o.type === 0 || o.type === 'role' || o.type === 'Role';

function readChannel(c) {
  const overwrites = values(c.permissionOverwrites?.cache).map((o) => ({
    id: String(o.id),
    type: isRoleOverwrite(o) ? 'role' : 'member',
    allow: big(o.allow),
    deny: big(o.deny),
  }));
  return {
    id: String(c.id),
    name: String(c.name ?? ''),
    type: c.type,
    parentId: c.parentId ? String(c.parentId) : null,
    position: Number(c.rawPosition ?? c.position ?? 0),
    topic: c.topic ?? null,
    nsfw: Boolean(c.nsfw),
    rateLimitPerUser: Number(c.rateLimitPerUser ?? 0),
    bitrate: c.bitrate == null ? null : Number(c.bitrate),
    userLimit: c.userLimit == null ? null : Number(c.userLimit),
    overwrites,
    // A forum or media channel's own settings.
    forum:
      c.type === DISCORD_CHANNEL.FORUM || c.type === DISCORD_CHANNEL.MEDIA
        ? {
            tags: (c.availableTags ?? []).map((t) => ({
              name: String(t.name ?? ''),
              moderated: Boolean(t.moderated),
              emojiName: t.emoji?.name ?? null,
            })),
            sortOrder: c.defaultSortOrder ?? null,
            layout: c.defaultForumLayout ?? null,
            slowmode: c.defaultThreadRateLimitPerUser ?? null,
          }
        : null,
  };
}

function isThread(c) {
  return typeof c.isThread === 'function' ? c.isThread() : false;
}

/**
 * A Discord server as plain data. Channels that are threads are left out; managed roles are listed (with
 * `managed: true`) so the report can say why they are not copied.
 * @param {any} guild  a discord.js Guild (or a test double of its shape)
 */
export function snapshotDiscordGuild(guild) {
  const everyoneId = String(guild.roles?.everyone?.id ?? guild.id);
  const base = big(guild.roles?.everyone?.permissions ?? guild.roles?.cache?.get?.(everyoneId)?.permissions);
  const snap = {
    id: String(guild.id),
    name: String(guild.name ?? ''),
    iconUrl: guild.iconURL?.({ size: 1024, extension: 'png' }) ?? null,
    bannerUrl: guild.bannerURL?.({ size: 1024, extension: 'png' }) ?? null,
    everyoneId,
    // A server marked age-restricted: its channels carry no flag of their own, so the copies get one.
    ageRestricted: Number(guild.nsfwLevel) === 3,
    channels: values(guild.channels?.cache)
      .filter((c) => !isThread(c))
      .map(readChannel),
    roles: values(guild.roles?.cache).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      color: Number(r.color ?? r.colour ?? 0),
      position: Number(r.rawPosition ?? r.position ?? 0),
      hoist: Boolean(r.hoist),
      mentionable: Boolean(r.mentionable),
      permissions: big(r.permissions),
      managed: Boolean(r.managed),
      isEveryone: String(r.id) === everyoneId,
    })),
    emojis: values(guild.emojis?.cache).map((e) => ({
      id: String(e.id),
      name: String(e.name ?? ''),
      animated: Boolean(e.animated),
      managed: Boolean(e.managed),
      url: e.imageURL?.({ extension: e.animated ? 'gif' : 'png', size: 128 }) ?? e.url ?? null,
    })),
    stickers: values(guild.stickers?.cache).map((st) => ({
      id: String(st.id),
      name: String(st.name ?? ''),
      description: st.description ?? '',
      tags: String(st.tags ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      // discord.js StickerFormatType: 1 PNG, 2 APNG, 3 Lottie, 4 GIF
      format: Number(st.format ?? 1),
      url: st.url ?? null,
    })),
  };
  // What @everyone can do in each channel on Discord, so a copy is never more open than the original.
  for (const ch of snap.channels) Object.assign(ch, everyoneAccess(base, ch.overwrites, everyoneId));
  return snap;
}

const BIT_ADMIN = 1n << 3n;
const BIT_VIEW = 1n << 10n;
const BIT_CONNECT = 1n << 20n;

/**
 * Can @everyone see a channel, and join it if it is a voice channel? Discord's own order: the role's permissions,
 * then the channel's @everyone overwrite (deny, then allow). Administrator sees everything.
 */
export function everyoneAccess(base, overwrites, everyoneId) {
  const o = overwrites.find((x) => x.type === 'role' && x.id === everyoneId);
  const perms = base & BIT_ADMIN ? ~0n : (base & ~(o?.deny ?? 0n)) | (o?.allow ?? 0n);
  return { everyoneCanView: (perms & BIT_VIEW) !== 0n, everyoneCanConnect: (perms & BIT_CONNECT) !== 0n };
}

/**
 * A Fluxer server as plain data: what is already there (a new server comes with a few channels and its
 * @everyone role). The mirror leaves all of it alone unless it made it.
 * @param {any} guild  a Fluxer SDK Guild (or a test double of its shape)
 */
export function snapshotFluxerGuild(guild) {
  const everyoneId = String(guild.id);
  return {
    id: String(guild.id),
    name: String(guild.name ?? ''),
    everyoneId,
    channels: values(guild.channels).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? ''),
      type: c.type,
      parentId: c.parentId ? String(c.parentId) : null,
      position: Number(c.position ?? 0),
    })),
    roles: values(guild.roles?.cache ?? guild.roles).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      position: Number(r.position ?? 0),
      permissions: big(r._permissions ?? r.permissions),
      managed: Boolean(r.managed),
      isEveryone: String(r.id) === everyoneId,
    })),
    emojiCount: values(guild.emojis).length,
    stickerCount: values(guild.stickers).length,
  };
}
