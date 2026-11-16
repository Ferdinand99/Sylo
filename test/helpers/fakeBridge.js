// A Discord and a Fluxer side for the bridge tests: two fake clients with one server each, text channels that
// record what Sylo says in them, and a fake webhook transport that records every send, edit and delete (and
// can be told to fail). The real transport (src/platform/webhooks.js) is covered separately.
import { ChannelType } from 'discord.js';
import { runtime } from '../../src/runtime.js';
import { createRelayQueue } from '../../src/modules/lib/bridgeQueue.js';
import { useBridgeParts } from '../../src/modules/bridge.js';

export const D_RAW = '710000000000000001';
export const F_RAW = '710000000000000002';
export const D = D_RAW;
export const F = `fluxer:${F_RAW}`;
export const ME_D = '999000000000000001';
export const ME_F = '999000000000000002';

let nextId = 80_000_000_000_000_000n;
export const snowflake = () => String((nextId += 1n));

/**
 * `nsfwOverride` and `parentId` are what Fluxer's age restriction reads (own override, else the category's,
 * else the server's); the plain `nsfw` is the channel's own mark.
 */
function makeChannel(
  guild,
  { id, name, nsfw = false, nsfwOverride = null, parentId = null, type = ChannelType.GuildText, deny = [] }
) {
  const channel = {
    id,
    name,
    type,
    nsfw,
    nsfwOverride,
    parentId,
    rawPosition: 0,
    guild,
    said: [],
    permissionsFor: () => ({ has: (perm) => !deny.includes(perm) }),
    send: async (payload) => {
      channel.said.push(payload);
      return { id: snowflake() };
    },
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

function makeGuild(client, { id, name }) {
  const guild = {
    id,
    name,
    client,
    ownerId: `owner-of-${id}`, // each server has its own owner (a platform user id)
    nsfw: false, // the server's own age restriction (Fluxer)
    channels: { cache: new Map() },
    emojis: { cache: new Map() },
    roles: { cache: new Map() },
    members: { me: { id: client.user.id }, cache: new Map() },
  };
  client.guilds.cache.set(id, guild);
  return guild;
}

/** Install the two fake clients; returns both servers and a way to add channels. */
export function installPlatforms() {
  const discord = { user: { id: ME_D }, guilds: { cache: new Map() }, isReady: () => true };
  const fluxer = { user: { id: ME_F }, guilds: { cache: new Map() }, isReady: () => true };
  runtime.clients.discord = discord;
  runtime.clients.fluxer = fluxer;
  const dGuild = makeGuild(discord, { id: D_RAW, name: 'Discord Home' });
  const fGuild = makeGuild(fluxer, { id: F_RAW, name: 'Fluxer Home' });
  return {
    discord,
    fluxer,
    dGuild,
    fGuild,
    channel: (guild, opts) => makeChannel(guild, { id: snowflake(), name: 'chat', ...opts }),
    /** Another pair of servers (for isolation tests). */
    extra: (suffix) => ({
      dGuild: makeGuild(discord, { id: `71000000000000${suffix}1`, name: `Discord ${suffix}` }),
      fGuild: makeGuild(fluxer, { id: `71000000000000${suffix}2`, name: `Fluxer ${suffix}` }),
    }),
  };
}

export function removePlatforms() {
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
}

/** An HTTP-ish error as the SDKs throw it. */
export const apiError = (status, { code, retryAfter } = {}) =>
  Object.assign(new Error(`HTTP ${status}`), {
    status,
    ...(code && { code }),
    ...(retryAfter && { retryAfter }),
  });

/** A webhook transport that records what the bridge does, and fails on request. */
export function fakeTransport() {
  const t = {
    hooks: [],
    sends: [],
    edits: [],
    removes: [],
    deleted: [],
    botDeletes: [],
    botDeleteFailures: [],
    removeFailures: [], // errors thrown by the next webhook deletes
    sendFailures: [], // errors thrown by the next sends, in order
    hookFailures: [], // errors thrown by the next createHook calls
    attempts: 0,
    async createHook(guildKey, channelId, name) {
      const next = t.hookFailures.shift();
      if (next) throw next;
      const hook = { id: snowflake(), token: `tok-${t.hooks.length + 1}` };
      t.hooks.push({ guildKey, channelId, name, ...hook });
      return hook;
    },
    async send(guildKey, hook, payload) {
      t.attempts += 1;
      const next = t.sendFailures.shift();
      if (next) throw next;
      const id = snowflake();
      t.sends.push({ guildKey, hook, payload, id });
      return id;
    },
    async edit(guildKey, hook, messageId, payload) {
      t.edits.push({ guildKey, hook, messageId, payload });
    },
    async remove(guildKey, hook, messageId) {
      const next = t.removeFailures.shift();
      if (next) throw next;
      t.removes.push({ guildKey, hook, messageId });
    },
    async botDelete(guildKey, channelId, messageId) {
      const next = t.botDeleteFailures.shift();
      if (next) throw next;
      t.botDeletes.push({ guildKey, channelId, messageId });
    },
    async deleteHook(guildKey, hook) {
      t.deleted.push({ guildKey, hook });
    },
  };
  return t;
}

/** Use a fake transport, an instant queue and a downloader that serves `files` (url -> bytes). */
export function useFakes({ files = {}, queue } = {}) {
  const transport = fakeTransport();
  const sleeps = [];
  const q =
    queue ??
    createRelayQueue({
      minGapMs: 0,
      sleep: async (ms) => {
        if (ms > 0) sleeps.push(ms); // the spacing between sends is 0 here
      },
    });
  const downloads = [];
  useBridgeParts({
    transport,
    queue: q,
    download: async (url, maxBytes) => {
      downloads.push({ url, maxBytes });
      const body = files[url];
      if (!body) return { ok: false, status: 404, body: Buffer.alloc(0) };
      return { ok: true, status: 200, body: Buffer.isBuffer(body) ? body : Buffer.from(body) };
    },
  });
  return { transport, sleeps, downloads, queue: q };
}

/** A chat message as the SDKs deliver it, with what the bridge reads. */
export function message({ channelId, content = '', author = {}, ...rest }) {
  const platformClient = rest.client;
  return {
    id: snowflake(),
    channelId,
    content,
    type: 0,
    system: false,
    webhookId: null,
    author: { id: snowflake(), username: 'alice', bot: false, ...author },
    member: { displayName: 'Alice' },
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    mentions: { users: new Map(), members: new Map(), roles: new Map() },
    reference: null,
    client: platformClient,
    ...rest,
  };
}
