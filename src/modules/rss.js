// RSS / Atom alerts — post a message when a followed feed publishes a new item.
// No API key: Sylo fetches the feed URL directly and parses it with the shared
// src/bot/lib/feed.js parser. Covers blogs, news sites, GitHub releases `.atom`,
// and — via a friendly handle rather than a raw URL — Reddit, Mastodon and
// Bluesky, each of which serves a plain RSS/Atom feed under the hood.
//
// config shape: { feeds: [ { id, type, ref, url, channelId, roleId, template } ] }
//   type — 'url' | 'reddit' | 'mastodon' | 'bluesky'
//   ref  — what the user typed for a non-url type (e.g. 'r/programming'); for
//          'url' it is the feed URL itself.
//   url  — the resolved feed URL the poll loop actually fetches.
// template placeholders: {title} {link} {author} {feed}
import { EmbedBuilder } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { seen, anySeen, markSeen, pruneScopePrefixOlderThan } from '../db/postedKeys.js';
import { parseFeed } from '../bot/lib/feed.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';

const COLOR = 0xee802f;
const POLL_MS = 5 * 60_000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; Sylo-Discord-Bot/1.0; +https://github.com/Ferdinand99/Sylo)';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

const MAX_FEEDS_PER_GUILD = 15;
const MAX_FETCHES_PER_TICK = 80; // global budget across all guilds
const MAX_POSTS_PER_FEED_PER_TICK = 3; // cap a burst; the rest are still marked seen

export const DEFAULT_TEMPLATE = '📰 **{title}**\n{link}';

const isId = (v) => /^\d{17,20}$/.test(v ?? '');
const isUrl = (v) => /^https?:\/\/\S+$/i.test(String(v ?? '').trim());
const newFeedId = () => randomBytes(4).toString('hex');
const feedScope = (feedId) => `rss:${feedId}`;

export function feedSource(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'feed';
  }
}

export const FEED_TYPES = ['url', 'reddit', 'mastodon', 'bluesky'];

/**
 * Turn a friendly feed reference into a canonical RSS/Atom URL plus a short
 * source label. `type` 'url' passes the reference straight through. Returns an
 * empty `url` when the reference doesn't parse for that type.
 * @param {string} type  one of FEED_TYPES
 * @param {string} ref   the raw handle / URL the user entered
 * @returns {{ url: string, label: string }}
 */
export function parseFeedRef(type, ref) {
  const s = String(ref ?? '').trim();
  if (!s) return { url: '', label: '' };

  if (type === 'reddit') {
    // r/name, u/name, user/name, a bare subreddit, or any reddit.com URL.
    const path = s.replace(/^https?:\/\/(?:[a-z0-9-]+\.)*reddit\.com/i, '').replace(/^\/+/, '');
    let kind = null;
    let name = null;
    const m = path.match(/^(r|u|user)\/([A-Za-z0-9_]{2,24})\b/i);
    if (m) {
      kind = m[1].toLowerCase() === 'r' ? 'r' : 'user';
      name = m[2];
    } else if (/^[A-Za-z0-9_]{2,24}$/.test(path)) {
      kind = 'r';
      name = path;
    }
    if (!name) return { url: '', label: '' };
    return {
      url: `https://www.reddit.com/${kind}/${name}/new/.rss`,
      label: `${kind === 'r' ? 'r' : 'u'}/${name}`,
    };
  }

  if (type === 'mastodon') {
    // @user@instance, user@instance, or https://instance/@user
    let host = null;
    let user = null;
    const url = s.match(/^https?:\/\/([A-Za-z0-9.-]+)\/@([A-Za-z0-9_]{1,30})\b/i);
    if (url) {
      host = url[1];
      user = url[2];
    } else {
      const at = s.match(/^@?([A-Za-z0-9_]{1,30})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$/);
      if (at) {
        user = at[1];
        host = at[2];
      }
    }
    if (!host || !user) return { url: '', label: '' };
    host = host.toLowerCase();
    return { url: `https://${host}/@${user}.rss`, label: `@${user}@${host}` };
  }

  if (type === 'bluesky') {
    // handle.bsky.social, @handle, did:plc:…, or a bsky.app/profile/ URL
    let handle = '';
    const url = s.match(/^https?:\/\/bsky\.app\/profile\/([^/\s]+)/i);
    if (url) {
      handle = decodeURIComponent(url[1]);
    } else if (/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/i.test(s)) {
      handle = s;
    } else {
      const h = s.replace(/^@/, '');
      if (
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(h)
      ) {
        handle = h;
      }
    }
    if (!handle) return { url: '', label: '' };
    return {
      url: `https://bsky.app/profile/${handle}/rss`,
      label: handle.startsWith('did:') ? handle : `@${handle}`,
    };
  }

  // 'url' and anything unrecognised
  return { url: isUrl(s) ? s : '', label: '' };
}

/** Short human label for a feed's origin — the handle for a friendly type, else the host. */
export function sourceLabel(feed = {}) {
  if (feed.type && feed.type !== 'url') {
    const { label } = parseFeedRef(feed.type, feed.ref);
    if (label) return label;
  }
  return feedSource(feed.url);
}

export function normaliseRssConfig(raw = {}) {
  const seenKeys = new Set();
  return {
    feeds: (Array.isArray(raw.feeds) ? raw.feeds : [])
      .map((f) => {
        const type = FEED_TYPES.includes(f.type) ? f.type : 'url';
        // Back-compat: pre-3.14 feeds stored only `url`, no `type`/`ref`.
        const ref = String(f.ref ?? (type === 'url' ? f.url : '') ?? '')
          .trim()
          .slice(0, 500);
        const { url } = parseFeedRef(type, ref);
        return {
          id: /^[0-9a-f]{8}$/.test(f.id ?? '') ? f.id : newFeedId(),
          type,
          ref,
          url: url.slice(0, 500),
          channelId: isId(f.channelId) ? f.channelId : '',
          roleId: isId(f.roleId) ? f.roleId : '',
          template: String(f.template ?? '').slice(0, 1000),
        };
      })
      .filter((f) => {
        if (!f.url || !f.channelId) return false;
        const k = `${f.url.toLowerCase()}|${f.channelId}`;
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      })
      .slice(0, MAX_FEEDS_PER_GUILD),
  };
}

// --- rendering --------------------------------------------------------

export function fillTemplate(tpl, { title, link, author, feed }) {
  return String(tpl || DEFAULT_TEMPLATE)
    .replaceAll('{title}', title ?? '')
    .replaceAll('{link}', link ?? '')
    .replaceAll('{author}', author ?? '')
    .replaceAll('{feed}', feed ?? '');
}

export function buildPayload(feed, entry) {
  const source = sourceLabel(feed);
  const link = /^https?:\/\//i.test(entry.link) ? entry.link : '';
  const content = `${feed.roleId ? `<@&${feed.roleId}> ` : ''}${fillTemplate(feed.template, {
    title: entry.title,
    link,
    author: entry.author,
    feed: source,
  })}`.trim();

  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle((entry.title || 'New item').slice(0, 256))
    .setFooter({ text: source })
    .setTimestamp(entry.published || Date.now());
  if (link) embed.setURL(link);
  if (entry.author) embed.setDescription(`by ${entry.author}`.slice(0, 300));
  if (/^https?:\/\//i.test(entry.image)) embed.setThumbnail(entry.image);

  return {
    content: content || undefined,
    embeds: [embed],
    allowedMentions: { roles: feed.roleId ? [feed.roleId] : [] },
  };
}

// --- poll loop -------------------------------------------------------

async function fetchEntries(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: ACCEPT },
    signal: AbortSignal.timeout(10_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** @param {string} guildId @param {{ id, type, ref, url, channelId, roleId, template }} feed */
export async function runFeed(guildId, feed) {
  const entries = await fetchEntries(feed.url);
  if (!entries.length) return;

  const scope = feedScope(feed.id);
  if (!anySeen(guildId, scope)) {
    // First look at this feed — remember everything, announce nothing.
    for (const e of entries) markSeen(guildId, scope, e.key);
    return;
  }

  const unseen = entries.filter((e) => !seen(guildId, scope, e.key)); // newest-first
  for (const e of unseen) markSeen(guildId, scope, e.key); // mark all, even past the post cap
  const toPost = unseen.slice(0, MAX_POSTS_PER_FEED_PER_TICK).reverse(); // oldest-first
  for (const e of toPost) {
    await sendToChannel(guildId, feed.channelId, buildPayload(feed, e));
  }
}

async function tick() {
  if (!runtime.client?.isReady()) return;
  let budget = MAX_FETCHES_PER_TICK;

  for (const guild of runtime.client.guilds.cache.values()) {
    if (!isModuleEnabled(guild.id, 'rss')) continue;
    const cfg = normaliseRssConfig(getGuildModule(guild.id, 'rss').config);
    for (const feed of cfg.feeds) {
      if (budget-- <= 0) return;
      try {
        await runFeed(guild.id, feed);
      } catch (err) {
        log.error('rss', `${feed.url}: ${err.message}`);
      }
    }
  }

  pruneScopePrefixOlderThan('rss:', KEEP_MS);
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('rss', 'tick failed:', err.message));
}, POLL_MS);
timer.unref();
setTimeout(() => tick().catch(() => {}), 45_000).unref();
