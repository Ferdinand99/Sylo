// Autoresponder: automatically reply when a message matches a trigger phrase
// (Dyno-style). Unlike custom commands there is no prefix — any message that
// matches fires.
//
// config shape (see normaliseAutoresponder):
//   {
//     cooldownSeconds: number,          // per-channel, anti-spam
//     ignoreChannels: string[],
//     ignoreRoles: string[],
//     responders: [ {
//       trigger, match: 'contains'|'exact'|'startswith'|'wholeword',
//       response, responseType: 'text'|'random-image'|'random-media', imageUrls: string[],
//       embed: bool, embedColor, deleteTrigger: bool
//     } ]
//   }
import { EmbedBuilder } from 'discord.js';
import { on } from './dispatch.js';
import { buildCustomReply } from './customCommands.js';
import { downloadAutoresponderVideo, videoExtension } from './lib/autoresponderVideo.js';

const VIDEO_URL = Symbol('autoresponderVideo');
const videoLinkContent = (caption, url) => {
  const text = String(caption || '')
    .trim()
    .slice(0, Math.max(0, 1999 - url.length));
  return text ? `${text}\n${url}` : url;
};
const isMediaRule = (rule) => ['random-image', 'random-media'].includes(rule.responseType);

export const AR_MATCH_MODES = ['contains', 'exact', 'startswith', 'wholeword'];
export const AR_PLACEHOLDERS = ['{user}', '{username}', '{server}', '{channel}'];

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};
const idList = (v) => [...new Set((Array.isArray(v) ? v : [v]).filter((x) => /^\d{17,20}$/.test(x)))];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const imageLines = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/))
    .map((url) => String(url).trim())
    .filter(Boolean);
const validImageUrl = (value) => {
  if (value.length > 2048 || (videoExtension(value) && value.length > 2000)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
};

/** Validate before saving so an incomplete image rule cannot silently disappear. */
export function autoresponderValidationError(responders) {
  const rows = Array.isArray(responders) ? responders : [];
  if (rows.length > 100) return 'Możesz dodać maksymalnie 100 odpowiedzi.';
  for (const [i, rule] of rows.entries()) {
    if (!rule) continue;
    const urls = imageLines(rule.imageUrls);
    const trigger = String(rule.trigger ?? '').trim();
    const response = String(rule.response ?? '').trim();
    if (!trigger && !response && !urls.length) continue;
    if (!trigger) return `Odpowiedź ${i + 1}: wpisz słowo wyzwalające.`;
    if (!isMediaRule(rule)) {
      if (!response)
        return `Odpowiedź ${i + 1}: wpisz treść odpowiedzi lub wybierz rodzaj „Losowy obrazek lub film”.`;
      continue;
    }
    if (!urls.length) return `Odpowiedź ${i + 1}: dodaj co najmniej jeden link do obrazka lub filmu.`;
    if (urls.length > 25) return `Odpowiedź ${i + 1}: możesz dodać maksymalnie 25 obrazków lub filmów.`;
    if (urls.some((url) => !validImageUrl(url)))
      return `Odpowiedź ${i + 1}: wpisz poprawne linki HTTP lub HTTPS, każdy w osobnym wierszu.`;
  }
  return null;
}

export function normaliseAutoresponder(raw = {}) {
  return {
    cooldownSeconds: clampInt(raw.cooldownSeconds, 0, 300, 2),
    ignoreChannels: idList(raw.ignoreChannels),
    ignoreRoles: idList(raw.ignoreRoles),
    responders: (Array.isArray(raw.responders) ? raw.responders : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        trigger: String(r.trigger ?? '')
          .trim()
          .slice(0, 200),
        match: AR_MATCH_MODES.includes(r.match) ? r.match : 'contains',
        response: String(r.response ?? '').slice(0, 2000),
        responseType: isMediaRule(r) ? r.responseType : 'text',
        imageUrls: [...new Set(imageLines(r.imageUrls).filter(validImageUrl))].slice(0, 25),
        embed: Boolean(r.embed),
        embedColor: /^#?[0-9a-fA-F]{6}$/.test(r.embedColor ?? '') ? r.embedColor.replace('#', '') : '5b7cfa',
        deleteTrigger: Boolean(r.deleteTrigger),
      }))
      .filter((r) => r.trigger !== '' && (isMediaRule(r) ? r.imageUrls.length > 0 : r.response.trim() !== ''))
      .slice(0, 100),
  };
}

/** Whether `content` matches `trigger` under `mode` (both compared case-insensitively). */
export function matchesTrigger(content, trigger, mode) {
  const c = content.toLowerCase();
  const t = trigger.toLowerCase();
  if (!t) return false;
  switch (mode) {
    case 'exact':
      return c.trim() === t;
    case 'startswith':
      return c.trimStart().startsWith(t);
    case 'wholeword':
      return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'u').test(c);
    case 'contains':
    default:
      return c.includes(t);
  }
}

/** Randomly choose an image or video. Video links can be prepared as attachments. */
export function buildAutoresponderReply(rule, context, random = Math.random) {
  const payload = buildCustomReply(
    { response: rule.response, embed: rule.embed, embedTitle: '', embedColor: rule.embedColor },
    context
  );
  if (isMediaRule(rule) && rule.imageUrls.length) {
    const url = rule.imageUrls[Math.floor(random() * rule.imageUrls.length)];
    if (videoExtension(url)) {
      payload[VIDEO_URL] = url;
      payload.content = videoLinkContent(rule.embed || !rule.response.trim() ? '' : payload.content, url);
      if (!rule.response.trim()) delete payload.embeds;
      return payload;
    }
    const image =
      payload.embeds?.[0] || new EmbedBuilder().setColor(parseInt(rule.embedColor || '5b7cfa', 16));
    image.setImage(url);
    payload.embeds = [image];
    if (!rule.response.trim()) delete payload.content;
  }
  return payload;
}

/** Upload supported CDN videos; fall back to the original link on failure. */
export async function prepareAutoresponderReply(
  rule,
  context,
  { random = Math.random, download = downloadAutoresponderVideo, attachVideos = true } = {}
) {
  const payload = buildAutoresponderReply(rule, context, random);
  const url = payload[VIDEO_URL];
  if (!url || !attachVideos) return payload;
  const buffer = await download(url).catch(() => null);
  if (!buffer) return payload;
  payload.files = [{ attachment: buffer, name: `odpowiedz.${videoExtension(url)}` }];
  // Rebuild only the caption so the fallback URL is not shown alongside a file.
  const caption = buildCustomReply(
    { response: rule.response, embed: rule.embed, embedTitle: '', embedColor: rule.embedColor },
    context
  );
  if (rule.response.trim() && !rule.embed) payload.content = caption.content;
  else delete payload.content;
  return payload;
}

// Per-channel cooldown so one busy trigger can't flood a channel.
const lastFire = new Map(); // `${guildId}:${channelId}` -> ts

on('autoresponder', 'messageCreate', async (message, rawConfig, guildId) => {
  if (message.author?.bot || !message.content || !message.member) return;
  const config = normaliseAutoresponder(rawConfig);
  if (config.responders.length === 0) return;

  if (config.ignoreChannels.includes(message.channelId)) return;
  if (config.ignoreRoles.some((r) => message.member.roles.cache.has(r))) return;

  const key = `${guildId}:${message.channelId}`;
  const now = Date.now();
  if (now - (lastFire.get(key) ?? 0) < config.cooldownSeconds * 1000) return;

  const hit = config.responders.find((r) => matchesTrigger(message.content, r.trigger, r.match));
  if (!hit) return;

  const me = message.guild.members.me;
  const required = ['SendMessages', 'ViewChannel'];
  if (hit.embed || isMediaRule(hit)) required.push('EmbedLinks');
  if (!message.channel.permissionsFor(me)?.has(required)) return;
  lastFire.set(key, now);

  if (hit.deleteTrigger && message.deletable) {
    await message.delete().catch(() => {});
  }

  const payload = await prepareAutoresponderReply(
    hit,
    {
      userId: message.author.id,
      username: message.author.username,
      guildName: message.guild.name,
      channelId: message.channelId,
      args: '',
    },
    { attachVideos: message.channel.permissionsFor(me)?.has('AttachFiles') }
  );
  await message.channel.send(payload).catch(async () => {
    if (payload.files?.length && payload[VIDEO_URL]) {
      await message.channel
        .send({ ...payload, files: [], content: videoLinkContent(payload.content, payload[VIDEO_URL]) })
        .catch(() => {});
    }
  });
});
