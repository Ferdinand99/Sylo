// Webhooks on both platforms behind one small interface, for the bridge (modules/bridge.js).
//
// A server key ("123..." or "fluxer:123...") says which platform a call is for, so the bridge never
// branches on the platform itself: it asks for a webhook in a channel, then sends, edits and deletes
// through it. The two SDKs differ in small ways (discord.js has a WebhookClient and names the avatar
// `avatarURL`; Fluxer builds a Webhook from an id and a token and names it `avatarUrl`; a file is
// `{ attachment, name }` on one and `{ name, data }` on the other), and those differences live here.
//
// Every message is sent with allowedMentions set to none: whatever the text says, a webhook copy never
// pings anyone. Callers pass a platform-neutral payload:
//   { content?, username?, avatarUrl?, embeds?, files?: [{ name, data: Buffer }] }
import { WebhookClient } from 'discord.js';
import { splitPlatformGuildId } from '../lib/platformId.js';
import { guildByKey } from './platformOf.js';

/** No mention of anything: the copy shows names as text and pings nobody. */
export const NO_MENTIONS = Object.freeze({ parse: [] });

/** @typedef {{ id: string, token: string, channelId?: string }} Hook  (the channel is only for the Fluxer SDK's own bookkeeping) */

/**
 * @typedef {object} BridgeTransport
 * @property {(guildKey: string, channelId: string, name: string) => Promise<Hook>} createHook
 * @property {(guildKey: string, hook: Hook, payload: object) => Promise<string>} send  resolves the new message id
 * @property {(guildKey: string, hook: Hook, messageId: string, payload: object) => Promise<void>} edit
 * @property {(guildKey: string, hook: Hook, messageId: string) => Promise<void>} remove
 * @property {(guildKey: string, hook: Hook) => Promise<void>} deleteHook  best effort
 */

const platformOfKey = (key) => splitPlatformGuildId(key)?.platform ?? 'discord';

// A webhook client per webhook, kept so each send does not build one. Bounded: a long-running instance
// with many links still holds only a few hundred.
const MAX_CACHED = 500;
const clients = new Map();
const remember = (cacheKey, make) => {
  let client = clients.get(cacheKey);
  if (!client) {
    if (clients.size >= MAX_CACHED) clients.delete(clients.keys().next().value);
    client = make();
    clients.set(cacheKey, client);
  }
  return client;
};

/** Forget the cached client of a webhook (it was deleted or replaced). */
export function forgetHook(hookId) {
  for (const key of [...clients.keys()]) if (key.endsWith(`|${hookId}`)) clients.delete(key);
}

async function discordHook(hook) {
  return remember(`discord|${hook.id}`, () => new WebhookClient({ id: hook.id, token: hook.token }));
}

async function fluxerHook(guild, hook) {
  const { Webhook } = await import('@fluxerjs/core');
  return remember(`fluxer|${hook.id}`, () =>
    Webhook.fromToken(guild.client, hook.id, hook.token, { channelId: hook.channelId, guildId: guild.id })
  );
}

const guildOf = (key) => {
  const guild = guildByKey(key);
  if (!guild) throw Object.assign(new Error('Sylo is not in that server'), { code: 'NO_GUILD' });
  return guild;
};

/** The payload in the shape one platform's send() takes. Always with allowedMentions none. */
export function webhookBody(platform, payload, { forEdit = false } = {}) {
  const out = { allowedMentions: NO_MENTIONS };
  if (payload.content !== undefined) out.content = payload.content;
  if (payload.embeds) out.embeds = payload.embeds;
  if (!forEdit) {
    if (payload.username) out.username = payload.username;
    if (payload.avatarUrl) out[platform === 'fluxer' ? 'avatarUrl' : 'avatarURL'] = payload.avatarUrl;
    if (payload.files?.length) {
      out.files = payload.files.map((f) =>
        platform === 'fluxer' ? { name: f.name, data: f.data } : { attachment: f.data, name: f.name }
      );
    }
  }
  return out;
}

/** @returns {BridgeTransport} */
export function createWebhookTransport() {
  return {
    async createHook(guildKey, channelId, name) {
      const guild = guildOf(guildKey);
      const channel = guild.channels?.cache?.get(channelId);
      if (!channel?.createWebhook)
        throw Object.assign(new Error('That channel cannot have a webhook'), { code: 'NO_CHANNEL' });
      const created = await channel.createWebhook({ name, reason: 'Sylo bridge' });
      if (!created?.id || !created?.token) throw new Error('The platform did not return a webhook token');
      return { id: String(created.id), token: String(created.token) };
    },

    async send(guildKey, hook, payload) {
      const platform = platformOfKey(guildKey);
      if (platform === 'fluxer') {
        const client = await fluxerHook(guildOf(guildKey), hook);
        const sent = await client.send(webhookBody(platform, payload), true);
        if (!sent?.id) throw new Error('Fluxer did not return the sent message');
        return String(sent.id);
      }
      const client = await discordHook(hook);
      const sent = await client.send(webhookBody(platform, payload));
      return String(sent.id);
    },

    async edit(guildKey, hook, messageId, payload) {
      const platform = platformOfKey(guildKey);
      const body = webhookBody(platform, payload, { forEdit: true });
      if (platform === 'fluxer') {
        const client = await fluxerHook(guildOf(guildKey), hook);
        await client.editMessage(messageId, body);
        return;
      }
      await (await discordHook(hook)).editMessage(messageId, body);
    },

    async remove(guildKey, hook, messageId) {
      const platform = platformOfKey(guildKey);
      if (platform === 'fluxer') {
        const client = await fluxerHook(guildOf(guildKey), hook);
        await client.deleteMessage(messageId);
        return;
      }
      await (await discordHook(hook)).deleteMessage(messageId);
    },

    async deleteHook(guildKey, hook) {
      const platform = platformOfKey(guildKey);
      try {
        if (platform === 'fluxer') {
          const client = await fluxerHook(guildOf(guildKey), hook);
          await client.delete();
        } else {
          await (await discordHook(hook)).delete('Sylo bridge unlinked');
        }
      } finally {
        forgetHook(hook.id);
      }
    },
  };
}
