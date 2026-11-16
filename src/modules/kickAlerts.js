// Kick alerts — announce in a channel when a Kick.com streamer goes live. Polls
// the official Kick API with an app access token; needs KICK_CLIENT_ID and
// KICK_CLIENT_SECRET (a free app at kick.com/settings/developer). When those are
// unset the poll loop no-ops and the dashboard shows a note.
//
// config shape: { alerts: [ { id, slug, channelId, roleId, message, plainText } ] }
// message placeholders: {name} {title} {game} {url} {viewers}
// plainText: send a plain message with no embed (for channels bridged elsewhere,
// e.g. a RuneLite Discord->game-chat plugin that ignores embeds).
import { allGuilds, allClientsReady, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder } from 'discord.js';
import { config } from '../config.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { seenValue, seenRow, markSeen, forget } from '../db/postedKeys.js';
import { postToChannel } from './lib/send.js';
import { settleEndedPost } from './lib/liveAlerts.js';
import { encodeLiveValue, decodeLiveValue, normaliseOnEnd } from '../lib/liveValue.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';
import { createQuarantine, fetchIsolated, rejectedWarning } from './lib/batchIsolation.js';

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

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  alerts: { maxItems: 50 },
  'alerts[].slug': { maxLength: 25 },
  'alerts[].message': { maxLength: 1500 },
};
const SLUG_RE = new RegExp(`^[a-z0-9_-]{2,${LIMITS['alerts[].slug'].maxLength}}$`);
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
          .replace(/^(?:https?:\/\/)?(?:www\.)?kick\.com\//, '')
          .replace(/^@/, ''),
        channelId: isId(a.channelId) ? a.channelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        message: String(a.message ?? '').slice(0, LIMITS['alerts[].message'].maxLength),
        plainText: Boolean(a.plainText),
        onEnd: normaliseOnEnd(a.onEnd),
      }))
      .filter((a) => {
        if (!SLUG_RE.test(a.slug) || !a.channelId || seen.has(a.slug + a.channelId)) return false;
        seen.add(a.slug + a.channelId);
        return true;
      })
      .slice(0, LIMITS.alerts.maxItems),
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
  if (!res.ok) throw Object.assign(new Error(`Kick /channels ${res.status}`), { status: res.status });
  return (await res.json()).data ?? [];
}

/**
 * Slugs the Kick API rejected (a 4xx for a request holding only that slug), left out of the
 * shared poll with a growing backoff so one saved value cannot stop alerts for every server.
 */
export const rejectedSlugs = createQuarantine();

/**
 * Live channels for a set of slugs, keyed by lowercased slug. Only currently-live
 * channels are included. A slug that Kick rejects is isolated (see fetchIsolated) and left out.
 * `report({ rejected, unresolved, inconclusive })` is called once with the slugs rejected now and every slug
 * this poll knows nothing about.
 */
export async function fetchLiveChannels(slugs, { report } = {}) {
  const out = new Map();
  const { results, rejected, unresolved, inconclusive } = await fetchIsolated(slugs, 50, getChannels, {
    quarantine: rejectedSlugs,
  });
  report?.({ rejected, unresolved, inconclusive });
  for (const ch of results) {
    if (ch?.stream?.is_live && ch.slug) out.set(String(ch.slug).toLowerCase(), ch);
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

/** One poll; exported for tests. */
export async function tick() {
  if (!allClientsReady() || !config.kickEnabled) return;

  const jobs = [];
  for (const guild of allGuilds()) {
    if (!(await isModuleEnabled(guildKey(guild), 'kick-alerts'))) continue;
    const cfg = normaliseKickConfig((await getGuildModule(guildKey(guild), 'kick-alerts')).config);
    for (const alert of cfg.alerts) jobs.push({ guildId: guildKey(guild), alert });
  }
  if (!jobs.length) return;

  const slugs = [...new Set(jobs.map((j) => j.alert.slug))];
  rejectedSlugs.prune(new Set(slugs));
  let live;
  let unresolved = new Set();
  try {
    live = await fetchLiveChannels(slugs, {
      report: ({ rejected, unresolved: left, inconclusive }) => {
        unresolved = left;
        if (inconclusive) {
          log.warn(
            'kick-alerts',
            'Every request of this poll was refused and no earlier accepted value is known to check against, so nothing was quarantined.'
          );
        }
        const warning = rejectedWarning('Kick slugs', rejected, (slug) => [
          ...new Set(jobs.filter((j) => j.alert.slug === slug).map((j) => j.guildId)),
        ]);
        if (warning) log.warn('kick-alerts', warning);
      },
    });
  } catch (err) {
    log.error('kick-alerts', 'poll failed:', err.message);
    return;
  }

  for (const { guildId, alert } of jobs) {
    // Not looked up this poll (rejected by Kick, waiting out a backoff, or over the request
    // budget): neither live nor offline as far as we know, so leave its state alone.
    if (unresolved.has(alert.slug)) continue;
    const channel = live.get(alert.slug);
    if (!channel) {
      const row = await seenRow(guildId, SCOPE, alert.slug);
      if (row) {
        await forget(guildId, SCOPE, alert.slug);
        const { channelId, messageId } = decodeLiveValue(row.value);
        await settleEndedPost({
          guildId,
          onEnd: alert.onEnd,
          post: { channelId, messageId, postedAt: row.posted_at },
          name: alert.slug,
          url: `https://kick.com/${alert.slug}`,
          plainText: alert.plainText,
        });
      }
      continue;
    }
    const key = streamKey(channel);
    if (decodeLiveValue(await seenValue(guildId, SCOPE, alert.slug)).ref === key) continue; // already announced

    const posted = await postToChannel(guildId, alert.channelId, buildPayload(channel, alert));
    await markSeen(guildId, SCOPE, alert.slug, encodeLiveValue(key, posted?.channelId, posted?.messageId), {
      upsert: true,
    });
  }
}

every(
  'kick-alerts',
  POLL_MS,
  () => {
    tick().catch((err) => log.error('kick-alerts', 'tick failed:', err.message));
  },
  { firstDelayMs: 30_000 }
);
