// YouTube alerts — announce new uploads and "went live" for a channel. No API
// key needed: new videos come from the per-channel Atom feed
// (youtube.com/feeds/videos.xml?channel_id=UC…), live status from a light scrape
// of the channel's /live page.
//
// config shape:
//   { alerts: [ { id, ytChannelId, name, discordChannelId, roleId,
//                 onVideo, onLive, videoMessage, liveMessage } ] }
// message placeholders: {name} {title} {url}
import { EmbedBuilder } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import {
  hasSeenAny,
  isVideoSeen,
  markVideoSeen,
  pruneYoutube,
  liveVideoId,
  livePost,
  markLive,
  markNotLive,
} from '../db/youtubeAlerts.js';
import { sendToChannel, postToChannel } from './lib/send.js';
import { settleEndedPost } from './lib/liveAlerts.js';
import { normaliseOnEnd } from '../lib/liveValue.js';
import { parseFeed as parseGenericFeed, grab, decodeEntities } from '../bot/lib/feed.js';
import { log } from '../lib/log.js';

const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const COLOR = 0xff0000;
const POLL_MS = 3 * 60_000;
const UA = 'Mozilla/5.0 (compatible; Sylo-Discord-Bot/1.0; +https://github.com/Ferdinand99/Sylo)';

export const DEFAULT_VIDEO_MESSAGE = '📺 **{name}** posted a new video: **{title}**\n{url}';
export const DEFAULT_LIVE_MESSAGE = '🔴 **{name}** is live on YouTube: **{title}**\n{url}';
const UC_RE = /^UC[\w-]{20,}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseYoutubeConfig(raw = {}) {
  const seen = new Set();
  return {
    alerts: (Array.isArray(raw.alerts) ? raw.alerts : [])
      .map((a, i) => ({
        id: a.id ? String(a.id) : String(i),
        ytChannelId: UC_RE.test(a.ytChannelId ?? '') ? a.ytChannelId : '',
        name: String(a.name ?? '').slice(0, 100),
        discordChannelId: isId(a.discordChannelId) ? a.discordChannelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        onVideo: a.onVideo !== false,
        onLive: Boolean(a.onLive),
        onEnd: normaliseOnEnd(a.onEnd),
        videoMessage: String(a.videoMessage ?? '').slice(0, 1500),
        liveMessage: String(a.liveMessage ?? '').slice(0, 1500),
      }))
      .filter((a) => {
        if (!a.ytChannelId || !a.discordChannelId) return false;
        if (seen.has(a.ytChannelId + a.discordChannelId)) return false;
        seen.add(a.ytChannelId + a.discordChannelId);
        return true;
      })
      .slice(0, 50),
  };
}

// --- resolve a URL / @handle / UC id to a channel id + name --------------

/** @returns {Promise<{ channelId: string, name: string } | null>} */
export async function resolveYtChannel(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (UC_RE.test(raw)) return { channelId: raw, name: '' };

  const fromUrl = grab(/(?:youtube\.com\/channel\/)(UC[\w-]{20,})/i, raw);
  if (fromUrl) return { channelId: fromUrl, name: '' };

  // A handle, /c/, /user/ or bare name → fetch the page and read the channel id.
  // The request is always built against a literal youtube.com origin — a pasted
  // URL only contributes its path/query, so it can't retarget the fetch at an
  // internal or unrelated host.
  let path;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'm.youtube.com') return null;
    path = `${parsed.pathname}${parsed.search}`;
  } else {
    path = `/@${encodeURIComponent(raw.replace(/^@/, ''))}`;
  }

  try {
    const res = await fetch(`https://www.youtube.com${path}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const channelId =
      grab(/"channelId":"(UC[\w-]{20,})"/, html) ||
      grab(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{20,})">/, html) ||
      grab(/channel\/(UC[\w-]{20,})/, html);
    if (!channelId) return null;
    const name =
      grab(/"channelMetadataRenderer":\{"title":"([^"]+)"/, html) ||
      grab(/<meta property="og:title" content="([^"]+)">/, html) ||
      '';
    return { channelId, name: decodeEntities(name).slice(0, 100) };
  } catch {
    return null;
  }
}

// --- feed (new videos) -------------------------------------------------

/**
 * Parse a YouTube Atom feed into recent entries, newest first. Uses the shared
 * feed parser and maps it onto the YouTube-specific shape (videoId, watch URL,
 * ytimg thumbnail fallback).
 */
export function parseFeed(xml) {
  return parseGenericFeed(xml)
    .map((e) => {
      const videoId = grab(/<yt:videoId>([^<]+)<\/yt:videoId>/, e.block) || grab(/[?&]v=([\w-]{11})/, e.link);
      if (!videoId) return null;
      return {
        videoId,
        title: e.title === 'Untitled' ? 'New video' : e.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        published: e.published,
        thumb: e.image || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        author: e.author,
      };
    })
    .filter(Boolean);
}

async function fetchFeed(ytChannelId) {
  const res = await fetch(FEED + ytChannelId, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`YT feed ${res.status}`);
  return parseFeed(await res.text());
}

// --- live check ------------------------------------------------------

/** @returns {Promise<{ live: boolean, videoId?: string, title?: string }>} */
export async function checkLive(ytChannelId) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${ytChannelId}/live`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!res.ok) return { live: false };
    const html = await res.text();
    const isLive = /"isLive":true/.test(html) || /"isLiveNow":true/.test(html);
    if (!isLive) return { live: false };
    const videoId =
      grab(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})">/, html) ||
      grab(/"videoId":"([\w-]{11})"/, html);
    const title = decodeEntities(
      grab(/"title":\s*{\s*"runs":\s*\[\s*{\s*"text":\s*"([^"]+)"/, html) ||
        grab(/<meta name="title" content="([^"]+)">/, html) ||
        'Live now'
    );
    return videoId ? { live: true, videoId, title } : { live: false };
  } catch {
    return { live: false };
  }
}

// --- rendering ----------------------------------------------------------

export function fillMessage(tpl, dflt, { name, title, url }) {
  return String(tpl || dflt)
    .replaceAll('{name}', name ?? '')
    .replaceAll('{title}', title ?? '')
    .replaceAll('{url}', url ?? '');
}

function payload(alert, { name, title, url, thumb }, kind) {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: kind === 'live' ? `${name} is live on YouTube` : `${name} · new video` })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setTimestamp(Date.now());
  if (thumb) embed.setImage(thumb);

  const content = fillMessage(
    kind === 'live' ? alert.liveMessage : alert.videoMessage,
    kind === 'live' ? DEFAULT_LIVE_MESSAGE : DEFAULT_VIDEO_MESSAGE,
    { name, title, url }
  ).trim();

  return {
    content: `${alert.roleId ? `<@&${alert.roleId}> ` : ''}${content}`.trim() || undefined,
    embeds: [embed],
    allowedMentions: { roles: alert.roleId ? [alert.roleId] : [] },
  };
}

// --- poll loop -----------------------------------------------------

async function tick() {
  if (!runtime.client?.isReady()) return;
  pruneYoutube();

  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'youtube-alerts')) continue;
    const cfg = normaliseYoutubeConfig(getGuildModule(guild.id, 'youtube-alerts').config);
    for (const alert of cfg.alerts) {
      try {
        await runAlert(guild.id, alert);
      } catch (err) {
        log.error('youtube-alerts', `${alert.ytChannelId}:`, err.message);
      }
    }
  }
}

async function runAlert(guildId, alert) {
  const c = alert.ytChannelId;

  if (alert.onVideo) {
    const entries = await fetchFeed(c);
    if (!hasSeenAny(guildId, c)) {
      // First poll for this channel — seed everything without alerting.
      for (const e of entries) markVideoSeen(guildId, c, e.videoId);
    } else {
      // Alert oldest-first for anything new.
      for (const e of [...entries].reverse()) {
        if (isVideoSeen(guildId, c, e.videoId)) continue;
        markVideoSeen(guildId, c, e.videoId);
        const name = alert.name || e.author || 'A channel';
        await sendToChannel(
          guildId,
          alert.discordChannelId,
          payload(alert, { name, title: e.title, url: e.url, thumb: e.thumb }, 'video')
        );
      }
    }
  }

  if (alert.onLive) {
    const state = await checkLive(c);
    const known = liveVideoId(guildId, c);
    if (state.live && state.videoId !== known) {
      markVideoSeen(guildId, c, state.videoId); // don't also fire a "new video" for the same stream
      const name = alert.name || 'A channel';
      const url = `https://www.youtube.com/watch?v=${state.videoId}`;
      const posted = await postToChannel(
        guildId,
        alert.discordChannelId,
        payload(
          alert,
          {
            name,
            title: state.title || 'Live now',
            url,
            thumb: `https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg`,
          },
          'live'
        )
      );
      markLive(guildId, c, state.videoId, posted);
    } else if (!state.live && known) {
      const post = livePost(guildId, c);
      markNotLive(guildId, c);
      await settleEndedPost({
        guildId,
        onEnd: alert.onEnd,
        post,
        name: alert.name || 'A channel',
        url: post?.videoId ? `https://www.youtube.com/watch?v=${post.videoId}` : undefined,
      });
    }
  }
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('youtube-alerts', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(() => tick().catch(() => {}), 40_000).unref();
