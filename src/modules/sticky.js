// Sticky messages: keep a message pinned to the bottom of a channel by
// re-posting it whenever someone else sends a message there.
//
// config shape: { stickies: [ { channelId, content, lastMessageId } ] }
import { on } from './dispatch.js';
import { runtime } from '../runtime.js';
import { setGuildModule, getGuildModule } from '../db/modules.js';

const REPOST_COOLDOWN_MS = 4000;
const lastRepost = new Map(); // channelId -> timestamp

on('sticky', 'messageCreate', async (message, config, guildId) => {
  const stickies = Array.isArray(config.stickies) ? config.stickies : [];
  const sticky = stickies.find((s) => s.channelId === message.channelId);
  if (!sticky || !sticky.content) return;
  if (message.author?.id === runtime.client.user.id) return; // ignore our own repost

  const now = Date.now();
  if (now - (lastRepost.get(sticky.channelId) ?? 0) < REPOST_COOLDOWN_MS) return;
  lastRepost.set(sticky.channelId, now);

  const channel = message.channel;
  const me = message.guild.members.me;
  if (!channel.permissionsFor(me)?.has(['SendMessages', 'ViewChannel'])) return;

  // Delete the previous sticky, post a fresh one.
  if (sticky.lastMessageId) {
    await channel.messages.delete(sticky.lastMessageId).catch(() => {});
  }
  const posted = await channel.send({ content: sticky.content, allowedMentions: { parse: [] } }).catch(() => null);
  if (!posted) return;

  // Persist the new message id (re-read config to avoid clobbering concurrent edits).
  const fresh = getGuildModule(guildId, 'sticky').config;
  const list = Array.isArray(fresh.stickies) ? fresh.stickies : [];
  const row = list.find((s) => s.channelId === sticky.channelId);
  if (row) {
    row.lastMessageId = posted.id;
    setGuildModule(guildId, 'sticky', { config: { ...fresh, stickies: list } });
  }
});
