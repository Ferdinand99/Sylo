// YouTube alerts — announce new uploads and "went live" for a channel. No API
// key needed: new videos come from the per-channel Atom feed
// (youtube.com/feeds/videos.xml?channel_id=UC…), live status from a light scrape
// of the channel's /live page.
//
// config shape:
//   { alerts: [ { id, ytChannelId, name, discordChannelId, roleId,
//                 onVideo, onLive, videoMessage, liveMessage } ] }
// message placeholders: {name} {title} {url}
import { allGuilds, allClientsReady, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder } from 'discord.js';
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
import { readTextCapped, SafeFetchError } from '../lib/safeFetch.js';
import { every } from './schedule.js';
import {
  FeedUnavailableError,
  feedDue,
  recordFeedFailure,
  recordFeedSuccess,
  pruneFeedHealth,
  liveDue,
  liveNotFoundFor,
  recordLiveFailure,
  recordLiveSuccess,
  pruneLiveHealth,
} from './lib/youtubeFeedHealth.js';

const FEED = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const COLOR = 0xff0000;
const POLL_MS = 3 * 60_000;
/** A live page that has answered 404 this long without a break is gone for good: the stream is over. */
const LIVE_GIVE_UP_MS = 6 * 60 * 60_000;
const UA = 'Mozilla/5.0 (compatible; Sylo-Discord-Bot/1.0; +https://github.com/Ferdinand99/Sylo)';

// feed.js's grab() defaults to a 300 KB scan cap, sized for RSS/Atom feed
// bodies. resolveYtChannel/checkLive scrape full YouTube HTML pages instead —
// now routinely ~2 MB — and the channelId/videoId/title JSON blobs they need
// sit well past 300 KB, so every grab() below silently came back empty no
// matter how healthy the fetch was (issue #178: "stopped working, nothing in
// the logs" — the fetch succeeded and there genuinely was nothing logged,
// because grab() never got far enough into the page to fail loudly). 3 MB
// covers today's page size with real headroom; still bounded so a change in
// how YouTube serves these pages can't turn a scan into unbounded work.
const PAGE_MAX_SCAN = 3_000_000;
const grabPage = (re, html) => grab(re, html, PAGE_MAX_SCAN);

// YouTube pages and feeds are read up to this many bytes: a page that size is already far past
// what the ids and titles are taken from, and an unbounded body must not be read into memory.
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export const DEFAULT_VIDEO_MESSAGE = '📺 **{name}** posted a new video: **{title}**\n{url}';
export const DEFAULT_LIVE_MESSAGE = '🔴 **{name}** is live on YouTube: **{title}**\n{url}';
/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  alerts: { maxItems: 50 },
  'alerts[].name': { maxLength: 100 },
  'alerts[].videoMessage': { maxLength: 1500 },
  'alerts[].liveMessage': { maxLength: 1500 },
};
const UC_RE = /^UC[\w-]{20,}$/;
const isId = (v) => /^\d{17,20}$/.test(v ?? '');

export function normaliseYoutubeConfig(raw = {}) {
  const seen = new Set();
  return {
    alerts: (Array.isArray(raw.alerts) ? raw.alerts : [])
      .map((a, i) => ({
        id: a.id ? String(a.id) : String(i),
        ytChannelId: UC_RE.test(a.ytChannelId ?? '') ? a.ytChannelId : '',
        name: String(a.name ?? '').slice(0, LIMITS['alerts[].name'].maxLength),
        discordChannelId: isId(a.discordChannelId) ? a.discordChannelId : '',
        roleId: isId(a.roleId) ? a.roleId : '',
        onVideo: a.onVideo !== false,
        onLive: Boolean(a.onLive),
        onEnd: normaliseOnEnd(a.onEnd),
        videoMessage: String(a.videoMessage ?? '').slice(0, LIMITS['alerts[].videoMessage'].maxLength),
        liveMessage: String(a.liveMessage ?? '').slice(0, LIMITS['alerts[].liveMessage'].maxLength),
      }))
      .filter((a) => {
        if (!a.ytChannelId || !a.discordChannelId) return false;
        if (seen.has(a.ytChannelId + a.discordChannelId)) return false;
        seen.add(a.ytChannelId + a.discordChannelId);
        return true;
      })
      .slice(0, MAX_YOUTUBE_ALERTS),
  };
}

// --- resolve a URL / @handle / UC id to a channel id + name --------------

/** @returns {Promise<{ channelId: string, name: string } | null>} */
/** Alerts per server; a save also looks up at most this many channels on youtube.com. */
export const MAX_YOUTUBE_ALERTS = LIMITS.alerts.maxItems;

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
  // Only a plain channel path — no protocol-relative "//host", no control chars.
  if (!/^\/[A-Za-z0-9@%._~/?=&+-]{1,200}$/.test(path) || path.startsWith('//')) return null;

  // resolveYtChannel/checkLive are the only two scraping-based (not
  // official-API) pieces in this codebase's alert modules — the fragile
  // part, since a YouTube-side page change or IP-based rate limit/challenge
  // breaks them with no client-visible error at all, just "nothing happens".
  // Every return-null path below logs *why*, distinctly, so a report like
  // "it stopped working, nothing in the logs" (issue #178) is diagnosable
  // instead of a dead end — previously all three were silent.
  try {
    const res = await fetch(`https://www.youtube.com${path}`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('youtube-alerts', `resolve ${path}: HTTP ${res.status}`);
      return null;
    }
    const html = await readTextCapped(res, MAX_PAGE_BYTES);
    const channelId =
      grabPage(/"channelId":"(UC[\w-]{20,})"/, html) ||
      grabPage(/<meta itemprop="(?:identifier|channelId)" content="(UC[\w-]{20,})">/, html) ||
      grabPage(/channel\/(UC[\w-]{20,})/, html);
    if (!channelId) {
      log.warn(
        'youtube-alerts',
        `resolve ${path}: no channel id found in the response (${html.length} bytes) — YouTube may have changed its page format, or served a consent/challenge page`
      );
      return null;
    }
    const name =
      grabPage(/"channelMetadataRenderer":\{"title":"([^"]+)"/, html) ||
      grabPage(/<meta property="og:title" content="([^"]+)">/, html) ||
      '';
    return { channelId, name: decodeEntities(name).slice(0, LIMITS['alerts[].name'].maxLength) };
  } catch (err) {
    log.warn('youtube-alerts', `resolve ${path}: ${err.message}`);
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

/**
 * Fetch and parse a channel's feed. A failure that is not ours (an HTTP error status, a timeout, a
 * dropped connection) throws FeedUnavailableError, which the poll counts quietly (see
 * lib/youtubeFeedHealth.js); anything else, such as a parser bug, throws as it is and is logged.
 */
async function fetchFeed(ytChannelId) {
  let res;
  try {
    res = await fetch(FEED + ytChannelId, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new FeedUnavailableError(timedOut ? 'timeout' : `network error: ${err?.message ?? err}`);
  }
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw new FeedUnavailableError(`YT feed ${res.status}`, res.status);
  }
  let xml;
  try {
    xml = await readTextCapped(res, MAX_PAGE_BYTES);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err; // a body past our cap is not a transient failure
    throw new FeedUnavailableError(`network error: ${err?.message ?? err}`);
  }
  return parseFeed(xml);
}

// --- live check ------------------------------------------------------

const CHANNEL_ID = '(UC[\\w-]{20,})';
/** How far past an anchor each lookup reads. The page is full of other videos and channels, so a
 * field is only trusted close to the thing that says whose it is, never "anywhere on the page". */
const CURRENT_VIDEO_SCAN = 8_000;
const PAGE_OWNER_SCAN = 500;
const OWNER_SCAN = 4_000;
const TITLE_SCAN = 1_500;
/** videoDetails carries the whole description, so its object may be long: read it up to this size. */
const VIDEO_DETAILS_MAX = 64_000;

/**
 * The JSON object that follows `anchor` (like `"currentVideoEndpoint":`), or null when it is missing,
 * cut off or not JSON. With `startsWith` the first occurrence of the anchor whose object begins with
 * that text is used: a page has several "videoDetails" objects, and only the player's starts with its
 * video id.
 */
function jsonObjectAfter(page, anchor, maxLen, startsWith = '{') {
  let at = page.indexOf(anchor);
  let i = -1;
  while (at >= 0) {
    i = at + anchor.length;
    while (/\s/.test(page[i] ?? '')) i += 1;
    if (page.startsWith(startsWith, i)) break;
    at = page.indexOf(anchor, at + anchor.length);
  }
  if (at < 0) return null;
  const limit = Math.min(page.length, i + maxLen);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < limit; j += 1) {
    const ch = page[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(page.slice(i, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The first capture of `re` in the `len` characters after the first `anchor`, or null. */
function grabAfter(page, anchor, re, len) {
  const at = page.indexOf(anchor);
  if (at < 0) return null;
  const from = at + anchor.length;
  return (page.slice(from, from + len).match(re) || [])[1] || null;
}

const validVideoId = (id) => (typeof id === 'string' && /^[\w-]{11}$/.test(id) ? id : null);

/**
 * Read a /channel/<id>/live page. It only counts as that channel's live stream when the video on
 * the page belongs to the watched channel: with no player response the page shows recommended
 * videos too, and the first video id on it can be another channel's stream (issue #377).
 * @returns {{ live: boolean|null, videoId?: string, title?: string, reason?: string }}
 */
function readLivePage(html, ytChannelId) {
  const page = html.length > PAGE_MAX_SCAN ? html.slice(0, PAGE_MAX_SCAN) : html;
  const details = jsonObjectAfter(page, '"videoDetails":', VIDEO_DETAILS_MAX, '{"videoId":');

  // With the video's own details, its own flag decides; an upcoming or ended video of the channel
  // is not live, even when a recommended stream on the same page is.
  const isLive = details
    ? details.isLive === true
    : /"isLive":true/.test(page) || /"isLiveNow":true/.test(page);
  if (!isLive) return { live: false };

  const videoId =
    grabPage(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})">/, page) ||
    validVideoId(details?.videoId) ||
    validVideoId(
      jsonObjectAfter(page, '"currentVideoEndpoint":', CURRENT_VIDEO_SCAN)?.watchEndpoint?.videoId
    );
  if (!videoId) return { live: false };

  const owner =
    (typeof details?.channelId === 'string' ? details.channelId : null) ||
    grabAfter(
      page,
      '"pageOwnerDetails":',
      new RegExp(`"externalChannelId":"${CHANNEL_ID}"`),
      PAGE_OWNER_SCAN
    ) ||
    grabAfter(page, '"videoOwnerRenderer":', new RegExp(`"browseId":"${CHANNEL_ID}"`), OWNER_SCAN);
  // Never announce what cannot be verified, and never end a running post because of it.
  if (!owner) return { live: null, reason: 'owner unknown' };
  if (owner !== ytChannelId) return { live: false };

  const title = decodeEntities(
    (typeof details?.title === 'string' && details.title.trim() ? details.title : null) ||
      grabPage(/<meta name="title" content="([^"]+)">/, page) ||
      // The runs text of any video on the page would do for the old regex; only the one right after
      // the current video's own header is that video's title, the rest are recommendations.
      grabAfter(
        page,
        '"videoPrimaryInfoRenderer":',
        /"title":\s*{\s*"runs":\s*\[\s*{\s*"text":\s*"([^"]+)"/,
        TITLE_SCAN
      ) ||
      'Live now'
  );
  return { live: true, videoId, title };
}

/**
 * Is the channel live? `live: null` means unknown: the page could not be read (an HTTP error, a
 * timeout, a body past the cap), which is not the same as "not live" and must not end a live post.
 * The caller counts it (lib/youtubeFeedHealth.js) instead of a log line per failure.
 * @returns {Promise<{ live: boolean|null, videoId?: string, title?: string, status?: number, reason?: string }>}
 */
export async function checkLive(ytChannelId) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${ytChannelId}/live`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    // Not-ok is a real fetch problem (blocked/rate-limited/etc.), unlike "not currently live",
    // which is the normal, frequent outcome of this poll. Unknown, never "not live".
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { live: null, status: res.status, reason: `HTTP ${res.status}` };
    }
    const html = await readTextCapped(res, MAX_PAGE_BYTES);
    return readLivePage(html, ytChannelId);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { live: null, reason: timedOut ? 'timeout' : String(err?.message ?? err) };
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

// --- announce a video (poll and WebSub push share this) -----------------

// Videos being announced right now, so a poll and a push that reach the same video at the same
// moment cannot both pass the "seen?" check before either has marked it.
const announcing = new Set();

/**
 * Announce one feed entry for one alert, unless it was announced before. The one path every new
 * video takes, from the poll (runAlert) and from a WebSub push (modules/youtubeWebsub.js), so the
 * posted_keys dedup covers both. Marked seen only once the send succeeded, so a failed delivery
 * retries on the next poll instead of being dropped.
 * @param {string} guildId
 * @param {{ ytChannelId: string, discordChannelId: string, name?: string }} alert
 * @param {{ videoId: string, title: string, url: string, thumb?: string, author?: string }} entry  from parseFeed()
 * @returns {Promise<boolean>} whether a message was sent now
 */
export async function announceVideo(guildId, alert, entry) {
  const c = alert.ytChannelId;
  const key = `${guildId}|${c}|${entry.videoId}`;
  if (announcing.has(key)) return false;
  announcing.add(key);
  try {
    if (await isVideoSeen(guildId, c, entry.videoId)) return false;
    const name = alert.name || entry.author || 'A channel';
    const sent = await sendToChannel(
      guildId,
      alert.discordChannelId,
      payload(alert, { name, title: entry.title, url: entry.url, thumb: entry.thumb }, 'video')
    );
    if (sent) await markVideoSeen(guildId, c, entry.videoId);
    return sent;
  } finally {
    announcing.delete(key);
  }
}

// --- poll loop -----------------------------------------------------

async function tick() {
  if (!allClientsReady()) return;
  await pruneYoutube();

  // One clock for the whole pass: the backoff compares it with the clock of the last pass, so a slow
  // earlier alert must not push a later one past its slot.
  const now = Date.now();
  const watchedFeeds = new Set();
  const watchedLive = new Set();
  for (const guild of allGuilds()) {
    if (!(await isModuleEnabled(guildKey(guild), 'youtube-alerts'))) continue;
    const cfg = normaliseYoutubeConfig((await getGuildModule(guildKey(guild), 'youtube-alerts')).config);
    for (const alert of cfg.alerts) {
      if (alert.onVideo) watchedFeeds.add(alert.ytChannelId);
      if (alert.onLive) watchedLive.add(alert.ytChannelId);
      try {
        await runAlert(guildKey(guild), alert, now);
      } catch (err) {
        log.error('youtube-alerts', `${alert.ytChannelId}:`, err.message);
      }
    }
  }
  // Only after a whole pass: a channel nobody watches any more must not keep its failure count.
  pruneFeedHealth(watchedFeeds);
  pruneLiveHealth(watchedLive);
}

/**
 * Poll one channel's feed and announce what is new. A feed that cannot be reached is counted, not
 * logged (lib/youtubeFeedHealth.js), and polled less often until it answers. Nothing is marked
 * seen meanwhile, so the poll that gets an answer announces whatever was missed.
 * @returns {Promise<boolean>} whether the feed was read (false: backing off, or it failed)
 */
async function pollFeed(guildId, alert, now) {
  const c = alert.ytChannelId;
  if (!feedDue(c, now)) return false;
  let entries;
  try {
    entries = await fetchFeed(c);
  } catch (err) {
    if (!(err instanceof FeedUnavailableError)) throw err;
    recordFeedFailure(c, err, POLL_MS, now);
    return false;
  }
  recordFeedSuccess(c);
  if (!(await hasSeenAny(guildId, c))) {
    // First poll for this channel — seed everything without alerting.
    for (const e of entries) await markVideoSeen(guildId, c, e.videoId);
  } else {
    // Alert oldest-first for anything new. Only marked seen once the send
    // actually succeeds, so a failed delivery (missing permissions, a
    // deleted channel, a transient API error, …) retries on the next poll
    // instead of being silently and permanently dropped.
    for (const e of [...entries].reverse()) {
      await announceVideo(guildId, alert, e);
    }
  }
  return true;
}

/** The stream is over: forget it and settle its "is live" post the way the alert is set up to. */
async function endLivePost(guildId, alert, c) {
  const post = await livePost(guildId, c);
  await markNotLive(guildId, c);
  await settleEndedPost({
    guildId,
    onEnd: alert.onEnd,
    post,
    name: alert.name || 'A channel',
    url: post?.videoId ? `https://www.youtube.com/watch?v=${post.videoId}` : undefined,
  });
}

/** @param {number} [now]  for tests: the clock the feed backoff reads */
export async function runAlert(guildId, alert, now = Date.now()) {
  const c = alert.ytChannelId;

  // A dead feed does not stop the live check below: that reads another page.
  const feedRead = alert.onVideo ? await pollFeed(guildId, alert, now) : true;

  if (alert.onLive) {
    // The live branch marks the stream as seen, which would make an alert whose feed was never read
    // look seeded: the first good feed poll would then announce every old upload. Wait for the seed.
    if (!feedRead && !(await hasSeenAny(guildId, c))) return;
    // A page that cannot be read leaves a running live post alone (below), but not for ever: once it
    // has answered 404 without a break for hours, the channel is gone and the stream with it. Checked
    // before the backoff gate, so every server that watches the channel ends its own post.
    if (liveNotFoundFor(c, now, LIVE_GIVE_UP_MS) && (await liveVideoId(guildId, c))) {
      await endLivePost(guildId, alert, c);
    }
    if (!liveDue(c, now)) return;
    const state = await checkLive(c);
    if (state.live === null) {
      // Unknown, not "not live": leave a running live post alone and do not announce again.
      recordLiveFailure(
        c,
        new FeedUnavailableError(state.reason ?? 'unknown', state.status ?? null),
        POLL_MS,
        now
      );
      return;
    }
    recordLiveSuccess(c);
    const known = await liveVideoId(guildId, c);
    if (state.live && state.videoId !== known) {
      // A new stream replaces a known one (it was restarted while the page could not be read): the
      // earlier post is over and is settled once the new one is out.
      const earlier = known ? await livePost(guildId, c) : null;
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
      // Only recorded on a successful post — otherwise `known` stays stale and
      // the next tick retries instead of treating a failed send as handled.
      if (posted) {
        await markVideoSeen(guildId, c, state.videoId); // don't also fire a "new video" for the same stream
        await markLive(guildId, c, state.videoId, posted);
        if (earlier) {
          await settleEndedPost({
            guildId,
            onEnd: alert.onEnd,
            post: earlier,
            name,
            url: earlier.videoId ? `https://www.youtube.com/watch?v=${earlier.videoId}` : undefined,
          });
        }
      }
    } else if (!state.live && known) {
      await endLivePost(guildId, alert, c);
    }
  }
}

every(
  'youtube-alerts',
  POLL_MS,
  // Returned, so the scheduler sees a tick that is still running and skips the next one.
  () => tick().catch((err) => log.error('youtube-alerts', 'tick failed:', err.message)),
  { firstDelayMs: 40_000 }
);
