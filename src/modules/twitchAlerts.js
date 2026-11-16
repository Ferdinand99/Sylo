// Twitch alerts — announce in a channel when a streamer goes live. Polls the
// Twitch Helix API with an app access token; needs TWITCH_CLIENT_ID and
// TWITCH_CLIENT_SECRET (free app at dev.twitch.tv/console). When those are
// unset the poll loop no-ops and the dashboard shows a note.
//
// config shape: { alerts: [ { id, login, channelId, roleId, message, plainText } ] }
// message placeholders: {name} {title} {game} {url} {viewers}
// plainText: send a plain message with no embed (for channels bridged elsewhere,
// e.g. a RuneLite Discord->game-chat plugin that ignores embeds).
import { allGuilds, allClientsReady, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { announcedStreamId, announcedPost, markLive, markOffline } from '../db/twitchAlerts.js';
import { postToChannel } from './lib/send.js';
import { settleEndedPost } from './lib/liveAlerts.js';
import { normaliseOnEnd } from '../lib/liveValue.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';
import { createQuarantine, fetchIsolated, rejectedWarning } from './lib/batchIsolation.js';

const HELIX = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const COLOR = 0x9146ff;
const POLL_MS = 60_000;

export const DEFAULT_MESSAGE = '🔴 **{name}** is live on Twitch!';
// Plain-text mode has its own default: no markdown, and it carries the link
// since there is no embed to hold it.
export const DEFAULT_PLAIN_MESSAGE = '🔴 {name} is live on Twitch! {title} — {url}';
/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  alerts: { maxItems: 50 },
  'alerts[].login': { maxLength: 25 },
  'alerts[].message': { maxLength: 1500 },
};
const LOGIN_RE = new RegExp(`^[a-zA-Z0-9_]{3,${LIMITS['alerts[].login'].maxLength}}$`);
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
          .replace(/^(?:https?:\/\/)?(?:www\.)?twitch\.tv\//, ''),
        channelId: isId(a.channelId) ? a.channelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        message: String(a.message ?? '').slice(0, LIMITS['alerts[].message'].maxLength),
        plainText: Boolean(a.plainText),
        onEnd: normaliseOnEnd(a.onEnd),
      }))
      .filter((a) => {
        if (!LOGIN_RE.test(a.login) || !a.channelId || seen.has(a.login + a.channelId)) return false;
        seen.add(a.login + a.channelId);
        return true;
      })
      .slice(0, LIMITS.alerts.maxItems),
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
  if (!res.ok) throw Object.assign(new Error(`Twitch ${path} ${res.status}`), { status: res.status });
  return (await res.json()).data ?? [];
}

/**
 * Logins the Helix API rejected (a 4xx for a request holding only that login), left out of the
 * shared poll with a growing backoff so one saved value cannot stop alerts for every server.
 */
export const rejectedLogins = createQuarantine();

/**
 * Live streams for a set of logins, keyed by lowercased login. A login that Helix rejects is
 * isolated (see fetchIsolated) and left out. `report({ rejected, unresolved })` is called once with
 * the logins rejected now and every login this poll knows nothing about.
 */
export async function fetchLiveStreams(logins, { report } = {}) {
  const out = new Map();
  const { results, rejected, unresolved } = await fetchIsolated(
    logins,
    100,
    (batch) => helix('/streams', { user_login: batch }),
    { quarantine: rejectedLogins }
  );
  report?.({ rejected, unresolved });
  for (const s of results) out.set(s.user_login.toLowerCase(), s);
  return out;
}

/**
 * User records (for avatar / display name), keyed by lowercased login. They only decorate the
 * announcement, so a failure here (or a rejected login) leaves them out instead of failing the poll.
 */
export async function fetchUsers(logins) {
  const out = new Map();
  try {
    const { results } = await fetchIsolated(logins, 100, (batch) => helix('/users', { login: batch }), {
      quarantine: createQuarantine(),
    });
    for (const u of results) out.set(u.login.toLowerCase(), u);
  } catch (err) {
    log.debug('twitch-alerts', 'user lookup failed:', err.message);
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

export function buildPayload(stream, user, alert) {
  const login = stream.user_login.toLowerCase();
  const url = `https://twitch.tv/${login}`;
  const name = stream.user_name || user?.display_name || login;
  const vars = {
    name,
    title: stream.title,
    game: stream.game_name,
    url,
    viewers: stream.viewer_count,
  };
  const ping = alert.roleId ? `<@&${alert.roleId}> ` : '';
  const allowedMentions = { roles: alert.roleId ? [alert.roleId] : [] };

  if (alert.plainText) {
    let content = `${ping}${fillMessage(alert.message || DEFAULT_PLAIN_MESSAGE, vars)}`.trim();
    if (url && !content.includes(url)) content += `\n${url}`;
    return { content: content || undefined, embeds: [], allowedMentions };
  }

  const thumb = (stream.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720');
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${name} is live on Twitch`, url, iconURL: user?.profile_image_url || undefined })
    .setTitle(stream.title?.slice(0, 256) || 'Live now')
    .setURL(url)
    .setDescription(`Playing **${stream.game_name || 'something'}** · ${stream.viewer_count ?? 0} viewers`)
    .setTimestamp(Date.parse(stream.started_at) || Date.now());
  if (thumb) embed.setImage(`${thumb}?t=${Date.now()}`);

  const content = `${ping}${fillMessage(alert.message, vars)}`.trim();
  return { content: content || undefined, embeds: [embed], allowedMentions };
}

// --- poll loop -------------------------------------------------------

/** One poll; exported for tests. */
export async function tick() {
  if (!allClientsReady() || !config.twitchEnabled) return;

  // Gather every alert across enabled guilds.
  const jobs = [];
  for (const guild of allGuilds()) {
    if (!(await isModuleEnabled(guildKey(guild), 'twitch-alerts'))) continue;
    const cfg = normaliseTwitchConfig((await getGuildModule(guildKey(guild), 'twitch-alerts')).config);
    for (const alert of cfg.alerts) jobs.push({ guildId: guildKey(guild), alert });
  }
  if (!jobs.length) return;

  const logins = [...new Set(jobs.map((j) => j.alert.login))];
  rejectedLogins.prune(new Set(logins));
  let streams;
  let users;
  let unresolved = new Set();
  try {
    streams = await fetchLiveStreams(logins, {
      report: ({ rejected, unresolved: left }) => {
        unresolved = left;
        const warning = rejectedWarning('Twitch logins', rejected, (login) => [
          ...new Set(jobs.filter((j) => j.alert.login === login).map((j) => j.guildId)),
        ]);
        if (warning) log.warn('twitch-alerts', warning);
      },
    });
    users = await fetchUsers([...streams.keys()]);
  } catch (err) {
    log.error('twitch-alerts', 'poll failed:', err.message);
    return;
  }

  for (const { guildId, alert } of jobs) {
    // Not looked up this poll (rejected by Twitch, waiting out a backoff, or over the request
    // budget): neither live nor offline as far as we know, so leave its state alone.
    if (unresolved.has(alert.login)) continue;
    const stream = streams.get(alert.login);
    if (!stream) {
      const post = await announcedPost(guildId, alert.login);
      if (post) {
        await markOffline(guildId, alert.login);
        await settleEndedPost({
          guildId,
          onEnd: alert.onEnd,
          post,
          name: alert.login,
          url: `https://twitch.tv/${alert.login}`,
          plainText: alert.plainText,
        });
      }
      continue;
    }
    if ((await announcedStreamId(guildId, alert.login)) === stream.id) continue; // already announced

    const posted = await postToChannel(
      guildId,
      alert.channelId,
      buildPayload(stream, users.get(alert.login), alert)
    );
    await markLive(guildId, alert.login, stream.id, posted);
  }
}

every(
  'twitch-alerts',
  POLL_MS,
  () => {
    tick().catch((err) => log.error('twitch-alerts', 'tick failed:', err.message));
  },
  { firstDelayMs: 25_000 }
);
