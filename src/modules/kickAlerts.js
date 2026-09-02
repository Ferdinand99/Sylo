// Kick alerts — announce in a channel when a Kick.com streamer goes live. Polls
// the official Kick API with an app access token; needs KICK_CLIENT_ID and
// KICK_CLIENT_SECRET (a free app at kick.com/settings/developer). When those are
// unset the poll loop no-ops and the dashboard shows a note.
//
// config shape: { alerts: [ { id, slug, channelId, roleId, message, plainText } ] }
// message placeholders: {name} {title} {game} {url} {viewers}
// plainText: send a plain message with no embed (for channels bridged elsewhere,
// e.g. a RuneLite Discord->game-chat plugin that ignores embeds).
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { seenValue, markSeen, forget } from '../db/postedKeys.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

const API = 'https://api.kick.com/public/v1';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const COLOR = 0x53fc18; // Kick green
const POLL_MS = 60_000;
const SCOPE = 'kick';

export const DEFAULT_MESSAGE = '🟢 **{name}** is live on Kick!';
// Plain-text mode has its own default: no markdown, and it carries the link
// since there is no embed to hold it.
export const DEFAULT_PLAIN_MESSAGE = '🟢 {name} is live on Kick! {title} — {url}';
// Kick slugs are lowercase letters, digits, underscores and hyphens.
const SLUG_RE = /^[a-z0-9_-]{2,25}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseKickConfig(raw = {}) {
  const seen = new Set();
  return {
    alerts: (Array.isArray(raw.alerts) ? raw.alerts : [])
      .map((a, i) => ({
        id: a.id ? String(a.id) : String(i),
        slug: String(a.slug ?? '')
          .trim()
          .toLowerCase()
          .replace(/^.*kick\.com\//, '')
          .replace(/^@/, ''),
        channelId: isId(a.channelId) ? a.channelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        message: String(a.message ?? '').slice(0, 1500),
        plainText: Boolean(a.plainText),
      }))
      .filter((a) => {
        if (!SLUG_RE.test(a.slug) || !a.channelId || seen.has(a.slug + a.channelId)) return false;
        seen.add(a.slug + a.channelId);
        return true;
      })
      .slice(0, 50),
  };
}

// --- API client --------------------------------------------------------

let token = { value: null, expiresAt: 0 };

async function appToken() {
  if (token.value && Date.now() < token.expiresAt - 60_000) return token.value;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.kickClientId,
    client_secret: config.kickClientSecret,
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Kick token ${res.status}`);
  const json = await res.json();
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function getChannels(slugs) {
  const url = new URL(`${API}/channels`);
  for (const s of slugs) url.searchParams.append('slug', s);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await appToken()}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    token = { value: null, expiresAt: 0 }; // force a refresh next call
    throw new Error('Kick 401');
  }
  if (!res.ok) throw new Error(`Kick /channels ${res.status}`);
  return (await res.json()).data ?? [];
}

/**
 * Live channels for a set of slugs, keyed by lowercased slug. Only currently-live
 * channels are included.
 */
export async function fetchLiveChannels(slugs) {
  const out = new Map();
  for (let i = 0; i < slugs.length; i += 50) {
    for (const ch of await getChannels(slugs.slice(i, i + 50))) {
      if (ch?.stream?.is_live && ch.slug) out.set(String(ch.slug).toLowerCase(), ch);
    }
  }
  return out;
}

// --- rendering --------------------------------------------------------

export function fillMessage(tpl, { name, title, game, url, viewers }) {
  return String(tpl || DEFAULT_MESSAGE)
    .replaceAll('{name}', name ?? '')
    .replaceAll('{title}', title ?? '')
    .replaceAll('{game}', game ?? '')
    .replaceAll('{url}', url ?? '')
    .replaceAll('{viewers}', String(viewers ?? 0));
}

/** A stable identity for the current broadcast — Kick has no per-stream id. */
export function streamKey(channel) {
  return String(channel?.stream?.start_time || channel?.stream?.url || 'live');
}

export function buildPayload(channel, alert) {
  const slug = String(channel.slug).toLowerCase();
  const url = channel.stream?.url || `https://kick.com/${slug}`;
  const name = channel.slug;
  const title = channel.stream_title || 'Live now';
  const game = channel.category?.name || 'something';
  const viewers = channel.stream?.viewer_count ?? 0;
  const thumb = channel.stream?.thumbnail || channel.category?.thumbnail || '';

  const ping = alert.roleId ? `<@&${alert.roleId}> ` : '';
  const allowedMentions = { roles: alert.roleId ? [alert.roleId] : [] };
  const vars = { name, title: channel.stream_title, game: channel.category?.name, url, viewers };

  if (alert.plainText) {
    let content = `${ping}${fillMessage(alert.message || DEFAULT_PLAIN_MESSAGE, vars)}`.trim();
    if (url && !content.includes(url)) content += `\n${url}`;
    return { content: content || undefined, embeds: [], allowedMentions };
  }

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${name} is live on Kick`, url })
    .setTitle(title.slice(0, 256))
    .setURL(url)
    .setDescription(`Playing **${game}** · ${viewers} viewers`)
    .setTimestamp(Date.parse(channel.stream?.start_time) || Date.now());
  if (channel.banner_picture) embed.setThumbnail(channel.banner_picture);
  if (thumb) embed.setImage(`${thumb}${thumb.includes('?') ? '&' : '?'}t=${Date.now()}`);

  const content = `${ping}${fillMessage(alert.message, vars)}`.trim();
  return { content: content || undefined, embeds: [embed], allowedMentions };
}

// --- poll loop -------------------------------------------------------

async function tick() {
  if (!runtime.client?.isReady() || !config.kickEnabled) return;

  const jobs = [];
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'kick-alerts')) continue;
    const cfg = normaliseKickConfig(getGuildModule(guild.id, 'kick-alerts').config);
    for (const alert of cfg.alerts) jobs.push({ guildId: guild.id, alert });
  }
  if (!jobs.length) return;

  const slugs = [...new Set(jobs.map((j) => j.alert.slug))];
  let live;
  try {
    live = await fetchLiveChannels(slugs);
  } catch (err) {
    log.error('kick-alerts', 'poll failed:', err.message);
    return;
  }

  for (const { guildId, alert } of jobs) {
    const channel = live.get(alert.slug);
    if (!channel) {
      if (seenValue(guildId, SCOPE, alert.slug)) forget(guildId, SCOPE, alert.slug);
      continue;
    }
    const key = streamKey(channel);
    if (seenValue(guildId, SCOPE, alert.slug) === key) continue; // already announced

    markSeen(guildId, SCOPE, alert.slug, key, { upsert: true });
    await sendToChannel(guildId, alert.channelId, buildPayload(channel, alert));
  }
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('kick-alerts', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(() => tick().catch(() => {}), 30_000).unref();
