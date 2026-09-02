// RSS / Atom alerts — post a message when a followed feed publishes a new item.
// No API key: Sylo fetches the feed URL directly and parses it with the shared
// src/bot/lib/feed.js parser. Covers blogs, news sites, Reddit `.rss`, Mastodon
// feeds, GitHub releases `.atom`, etc.
//
// config shape: { feeds: [ { id, url, channelId, roleId, template } ] }
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

export function normaliseRssConfig(raw = {}) {
  const seenKeys = new Set();
  return {
    feeds: (Array.isArray(raw.feeds) ? raw.feeds : [])
      .map((f) => ({
        id: /^[0-9a-f]{8}$/.test(f.id ?? '') ? f.id : newFeedId(),
        url: isUrl(f.url) ? String(f.url).trim().slice(0, 500) : '',
        channelId: isId(f.channelId) ? f.channelId : '',
        roleId: isId(f.roleId) ? f.roleId : '',
        template: String(f.template ?? '').slice(0, 1000),
      }))
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
  const source = feedSource(feed.url);
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

/** @param {string} guildId @param {{ id, url, channelId, roleId, template }} feed */
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
