// Twitch alerts — announce in a channel when a streamer goes live. Polls the
// Twitch Helix API with an app access token; needs TWITCH_CLIENT_ID and
// TWITCH_CLIENT_SECRET (free app at dev.twitch.tv/console). When those are
// unset the poll loop no-ops and the dashboard shows a note.
//
// config shape: { alerts: [ { id, login, channelId, roleId, message } ] }
// message placeholders: {name} {title} {game} {url} {viewers}
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { announcedStreamId, markLive, markOffline } from '../db/twitchAlerts.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

const HELIX = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const COLOR = 0x9146ff;
const POLL_MS = 60_000;

export const DEFAULT_MESSAGE = '🔴 **{name}** is live on Twitch!';
const LOGIN_RE = /^[a-zA-Z0-9_]{3,25}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseTwitchConfig(raw = {}) {
  const seen = new Set();
  return {
    alerts: (Array.isArray(raw.alerts) ? raw.alerts : [])
      .map((a, i) => ({
        id: a.id ? String(a.id) : String(i),
        login: String(a.login ?? '')
          .trim()
          .toLowerCase()
          .replace(/^.*twitch\.tv\//, ''),
        channelId: isId(a.channelId) ? a.channelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        message: String(a.message ?? '').slice(0, 1500),
      }))
      .filter((a) => {
        if (!LOGIN_RE.test(a.login) || !a.channelId || seen.has(a.login + a.channelId)) return false;
        seen.add(a.login + a.channelId);
        return true;
      })
      .slice(0, 50),
  };
}

// --- Helix client --------------------------------------------------------

let token = { value: null, expiresAt: 0 };

async function appToken() {
  if (token.value && Date.now() < token.expiresAt - 60_000) return token.value;
  const body = new URLSearchParams({
    client_id: config.twitchClientId,
    client_secret: config.twitchClientSecret,
    grant_type: 'client_credentials',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Twitch token ${res.status}`);
  const json = await res.json();
  token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

async function helix(path, params) {
  const url = new URL(HELIX + path);
  for (const [k, vals] of Object.entries(params)) {
    for (const v of [].concat(vals)) url.searchParams.append(k, v);
  }
  const res = await fetch(url, {
    headers: { 'Client-Id': config.twitchClientId, Authorization: `Bearer ${await appToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) {
    token = { value: null, expiresAt: 0 }; // force refresh next call
    throw new Error('Twitch 401');
  }
  if (!res.ok) throw new Error(`Twitch ${path} ${res.status}`);
  return (await res.json()).data ?? [];
}

/** Live streams for a set of logins, keyed by lowercased login. */
export async function fetchLiveStreams(logins) {
  const out = new Map();
  for (let i = 0; i < logins.length; i += 100) {
    const batch = logins.slice(i, i + 100);
    for (const s of await helix('/streams', { user_login: batch })) {
      out.set(s.user_login.toLowerCase(), s);
    }
  }
  return out;
}

/** User records (for avatar / display name), keyed by lowercased login. */
export async function fetchUsers(logins) {
  const out = new Map();
  for (let i = 0; i < logins.length; i += 100) {
    for (const u of await helix('/users', { login: logins.slice(i, i + 100) })) {
      out.set(u.login.toLowerCase(), u);
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

function buildPayload(stream, user, alert) {
  const login = stream.user_login.toLowerCase();
  const url = `https://twitch.tv/${login}`;
  const name = stream.user_name || user?.display_name || login;
  const thumb = (stream.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720');

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${name} is live on Twitch`, url, iconURL: user?.profile_image_url || undefined })
    .setTitle(stream.title?.slice(0, 256) || 'Live now')
    .setURL(url)
    .setDescription(`Playing **${stream.game_name || 'something'}** · ${stream.viewer_count ?? 0} viewers`)
    .setTimestamp(Date.parse(stream.started_at) || Date.now());
  if (thumb) embed.setImage(`${thumb}?t=${Date.now()}`);

  const content = fillMessage(alert.message, {
    name,
    title: stream.title,
    game: stream.game_name,
    url,
    viewers: stream.viewer_count,
  }).trim();

  return {
    content: `${alert.roleId ? `<@&${alert.roleId}> ` : ''}${content}`.trim() || undefined,
    embeds: [embed],
    allowedMentions: { roles: alert.roleId ? [alert.roleId] : [] },
  };
}

// --- poll loop -------------------------------------------------------

async function tick() {
  if (!runtime.client?.isReady() || !config.twitchEnabled) return;

  // Gather every alert across enabled guilds.
  const jobs = [];
  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'twitch-alerts')) continue;
    const cfg = normaliseTwitchConfig(getGuildModule(guild.id, 'twitch-alerts').config);
    for (const alert of cfg.alerts) jobs.push({ guildId: guild.id, alert });
  }
  if (!jobs.length) return;

  const logins = [...new Set(jobs.map((j) => j.alert.login))];
  let streams;
  let users;
  try {
    streams = await fetchLiveStreams(logins);
    users = await fetchUsers([...streams.keys()]);
  } catch (err) {
    log.error('twitch-alerts', 'poll failed:', err.message);
    return;
  }

  for (const { guildId, alert } of jobs) {
    const stream = streams.get(alert.login);
    if (!stream) {
      if (announcedStreamId(guildId, alert.login)) markOffline(guildId, alert.login);
      continue;
    }
    if (announcedStreamId(guildId, alert.login) === stream.id) continue; // already announced

    markLive(guildId, alert.login, stream.id);
    await sendToChannel(guildId, alert.channelId, buildPayload(stream, users.get(alert.login), alert));
  }
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('twitch-alerts', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(() => tick().catch(() => {}), 25_000).unref();
