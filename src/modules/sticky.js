// Sticky messages: keep a message pinned to the bottom of a channel by
// re-posting it whenever someone else sends a message there.
//
// config shape:
//   { stickies: [ { channelId, content, embed, lastMessageId, repostOnBots, cooldownSeconds } ] }
// `embed` is a normaliseEmbedSpec() object or null — a sticky needs content,
// an embed, or both.
//
// repostOnBots  — also bump the sticky for messages from other bots / apps /
//                 webhooks *and* from Sylo itself (alerts, welcomes, composed
//                 embeds). Sylo's own sticky repost never counts. Default off.
// cooldownSeconds — minimum gap between reposts in that channel; 0 = the 4s
//                 default. Raise it so a busy channel doesn't repost constantly.
import { on } from './dispatch.js';
import { setGuildModule, getGuildModule } from '../db/modules.js';
import { buildEmbed } from './messageCreator.js';
import { normaliseEmbedSpec } from './welcomeChannel.js';

const DEFAULT_COOLDOWN_MS = 4000;
const MIN_COOLDOWN_S = 3;
const MAX_COOLDOWN_S = 3600;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

const embedIsEmpty = (e) =>
  !e ||
  (!e.title &&
    !e.description &&
    !e.image &&
    !e.thumbnail &&
    !e.authorName &&
    !e.footerText &&
    (!Array.isArray(e.fields) || e.fields.length === 0));

/**
 * Coerce stored/submitted config into the canonical shape. `prev` is the
 * currently-stored config, consulted only for each row's bot-managed
 * lastMessageId — callers on both the V1 and V2 dashboard routes already
 * have it at hand, so it's a plain param rather than a DB read in here.
 */
export function normaliseStickyConfig(raw = {}, prev = {}) {
  const prevById = new Map((Array.isArray(prev.stickies) ? prev.stickies : []).map((s) => [s.channelId, s]));
  const stickies = (Array.isArray(raw.stickies) ? raw.stickies : [])
    .map((s) => {
      const embed = s.embed && typeof s.embed === 'object' ? normaliseEmbedSpec(s.embed) : null;
      return {
        channelId: s.channelId,
        content: String(s.content ?? '').slice(0, 2000),
        embed: embedIsEmpty(embed) ? null : embed,
        lastMessageId: prevById.get(s.channelId)?.lastMessageId ?? null,
        repostOnBots: Boolean(s.repostOnBots),
        cooldownSeconds: Math.max(0, Math.min(MAX_COOLDOWN_S, Math.floor(Number(s.cooldownSeconds)) || 0)),
      };
    })
    .filter((s) => isId(s.channelId) && (s.content.trim() !== '' || s.embed));
  return { stickies };
}

const lastRepost = new Map(); // channelId -> timestamp

/** Resolve a sticky's repost cooldown to milliseconds. */
export function cooldownMs(sticky) {
  const s = Math.floor(Number(sticky?.cooldownSeconds));
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_S, Math.max(MIN_COOLDOWN_S, s)) * 1000;
}

/**
 * Whether an incoming message should trigger a repost of `sticky`.
 * @param {object} sticky  the matched config row
 * @param {{ isOwnSticky: boolean, isApp: boolean }} msg
 *   isOwnSticky — the message *is* the sticky Sylo last posted here (never react)
 *   isApp — from a bot / app / webhook, which now includes Sylo's own other
 *     messages (alerts, welcomes, composed embeds); gated by repostOnBots
 * @param {number|undefined} lastAt  ms of the last repost in this channel
 * @param {number} now
 */
export function shouldRepost(sticky, msg, lastAt, now) {
  if (!sticky?.content && !sticky?.embed) return false;
  if (msg.isOwnSticky) return false;
  if (msg.isApp && !sticky.repostOnBots) return false;
  return now - (lastAt ?? 0) >= cooldownMs(sticky);
}

on('sticky', 'messageCreateAny', async (message, config, guildId) => {
  const stickies = Array.isArray(config.stickies) ? config.stickies : [];
  const sticky = stickies.find((s) => s.channelId === message.channelId);
  if (!sticky) return;

  const msg = {
    // Only the sticky we last posted is off-limits — every other message from
    // Sylo (alerts, welcomes, composed embeds) is treated like any other app.
    isOwnSticky: Boolean(sticky.lastMessageId) && message.id === sticky.lastMessageId,
    isApp: Boolean(message.author?.bot) || Boolean(message.webhookId),
  };
  const now = Date.now();
  if (!shouldRepost(sticky, msg, lastRepost.get(sticky.channelId), now)) return;
  lastRepost.set(sticky.channelId, now);

  const channel = message.channel;
  const me = message.guild.members.me;
  const needed = ['SendMessages', 'ViewChannel', ...(sticky.embed ? ['EmbedLinks'] : [])];
  if (!channel.permissionsFor(me)?.has(needed)) return;

  // Delete the previous sticky, post a fresh one.
  if (sticky.lastMessageId) {
    await channel.messages.delete(sticky.lastMessageId).catch(() => {});
  }
  const embed = sticky.embed ? buildEmbed(sticky.embed) : null;
  const posted = await channel
    .send({
      content: sticky.content || undefined,
      embeds: embed ? [embed] : undefined,
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  if (!posted) return;

  // Persist the new message id (re-read config to avoid clobbering concurrent edits).
  const fresh = (await getGuildModule(guildId, 'sticky')).config;
  const list = Array.isArray(fresh.stickies) ? fresh.stickies : [];
  const row = list.find((s) => s.channelId === sticky.channelId);
  if (row) {
    row.lastMessageId = posted.id;
    await setGuildModule(guildId, 'sticky', { config: { ...fresh, stickies: list } });
  }
});
