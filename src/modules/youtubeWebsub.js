// YouTube alerts over WebSub (PubSubHubbub): instead of waiting for the next poll, YouTube's hub
// pushes a thin Atom entry the moment a channel uploads. Polling (modules/youtubeAlerts.js) stays
// as the safety net, and live detection stays on checkLive(); push only announces new uploads.
//
// On only when Sylo has a public address for the hub to call: DASHBOARD_URL must be https and
// its host not a local name or address (websubEnabled). Without one nothing is subscribed or
// mounted and the module logs it once.
//
// Flow: subscribe(channel) stores a row with a fresh per-subscription secret and asks the hub
// (POST, hub.mode=subscribe); the hub then calls GET /webhooks/youtube/<channel> to verify
// (verifyIntent); later pushes arrive as POSTs signed with that secret (handleNotification, after
// the route has checked the signature with verifySignature). Leases run ~5 days; the hourly tick
// renews any with under a day left and reconciles the table with what guilds watch.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { isLocalHostname } from '../lib/localHost.js';
import { log } from '../lib/log.js';
import { listEnabledModuleConfigs } from '../db/modules.js';
import {
  getWebsub,
  allWebsub,
  wantWebsub,
  unwantWebsub,
  setWebsubLease,
  touchWebsubNotified,
  deleteWebsub,
  websubDueBefore,
} from '../db/youtubeWebsub.js';
import { hasSeenAny } from '../db/youtubeAlerts.js';
import { announceVideo, normaliseYoutubeConfig, parseFeed } from './youtubeAlerts.js';
import { grab } from '../bot/lib/feed.js';
import { every, after } from './schedule.js';

export const HUB = 'https://pubsubhubbub.appspot.com/subscribe';
const TOPIC = 'https://www.youtube.com/xml/feeds/videos.xml?channel_id=';
export const CHANNEL_RE = /^UC[\w-]{22}$/;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Lease asked for: the hub may grant less (YouTube's grants 5 days). */
const LEASE_SECONDS = 5 * 24 * 60 * 60;
/** Renew when less than this is left of the lease. */
export const RENEW_BEFORE_MS = DAY_MS;
/** A lease from a verification request is clamped into this range (see verifyIntent). */
const MIN_LEASE_SECONDS = 3600;
const MAX_LEASE_SECONDS = 14 * 24 * 60 * 60;
/** A push for a video older than this is an edit of an old video, not a new upload; the poll decides. */
export const MAX_PUSH_AGE_MS = 2 * DAY_MS;
const BOOT_DELAY_MS = 20_000;
const MAX_CONCURRENT = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CHALLENGE = 500;
const UA = 'Mozilla/5.0 (compatible; Sylo-Discord-Bot/1.0; +https://github.com/Ferdinand99/Sylo)';

export const topicUrl = (channelId) => TOPIC + channelId;

// config is frozen, so a test that needs another DASHBOARD_URL swaps it here.
let dashboardUrlOverride;
const currentDashboardUrl = () =>
  dashboardUrlOverride !== undefined ? dashboardUrlOverride : config.dashboardUrl;
/** For tests only: act as if DASHBOARD_URL were `url` (undefined = read the config again). */
export function _setDashboardUrlForTests(url) {
  dashboardUrlOverride = url;
}

/**
 * The address a hub can call us on, or null when there is none: DASHBOARD_URL must be https and
 * its host neither a local name nor an IP address.
 * @param {string|null|undefined} [dashboardUrl]
 * @returns {string|null} the URL without a trailing slash
 */
export function websubBase(dashboardUrl = currentDashboardUrl()) {
  if (!dashboardUrl) return null;
  try {
    const u = new URL(dashboardUrl);
    if (u.protocol !== 'https:' || isLocalHostname(u.hostname)) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Is WebSub on: does Sylo have a public https address? */
export function websubEnabled(dashboardUrl = currentDashboardUrl()) {
  return websubBase(dashboardUrl) !== null;
}

export const callbackUrl = (channelId, dashboardUrl = currentDashboardUrl()) =>
  `${websubBase(dashboardUrl)}/webhooks/youtube/${channelId}`;

let loggedOff = false;
function logOffOnce() {
  if (loggedOff) return;
  loggedOff = true;
  log.info(
    'youtube-alerts',
    'WebSub push is off: it needs DASHBOARD_URL set to a public https address. Uploads arrive by polling.'
  );
}

// --- hub requests, queued ---------------------------------------------------

let active = 0;
const waiting = [];

/** Run `task` with at most MAX_CONCURRENT in flight, so a server with 50 channels does not burst. */
function queued(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          waiting.shift()?.();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

/** @returns {Promise<boolean>} whether the hub accepted the request (202 or 204) */
function hubRequest(mode, channelId, secret) {
  return queued(async () => {
    const body = new URLSearchParams({
      'hub.callback': callbackUrl(channelId),
      'hub.topic': topicUrl(channelId),
      'hub.mode': mode,
      'hub.verify': 'async',
    });
    if (mode === 'subscribe') {
      body.set('hub.secret', secret);
      body.set('hub.lease_seconds', String(LEASE_SECONDS));
    }
    const res = await fetch(HUB, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await res.body?.cancel?.();
    if (!res.ok) log.warn('youtube-alerts', `WebSub ${mode} ${channelId}: hub answered HTTP ${res.status}`);
    return res.ok;
  });
}

// --- subscribe / unsubscribe / renew ---------------------------------------

/**
 * Ask the hub to push for a channel. Stores the row first (the hub verifies by calling us back
 * within moments). A renewal keeps the row's secret. Never throws.
 * @returns {Promise<boolean>} whether the hub accepted the request
 */
export async function subscribe(channelId) {
  if (!websubEnabled() || !CHANNEL_RE.test(channelId)) return false;
  try {
    const secret = (await getWebsub(channelId))?.secret ?? randomBytes(32).toString('hex');
    await wantWebsub(channelId, secret);
    return await hubRequest('subscribe', channelId, secret);
  } catch (err) {
    log.warn('youtube-alerts', `WebSub subscribe ${channelId}: ${err.message}`);
    return false;
  }
}

/**
 * Stop the push for a channel nobody watches. The row stays, marked unwanted, until the hub's
 * verification request for the unsubscribe arrives (then it is deleted); one still there when
 * its lease runs out is deleted by the next reconcile. Never throws.
 * @returns {Promise<boolean>} whether the hub accepted the request
 */
export async function unsubscribe(channelId) {
  if (!websubEnabled() || !CHANNEL_RE.test(channelId)) return false;
  try {
    const row = await getWebsub(channelId);
    if (!row) return false;
    await unwantWebsub(channelId);
    return await hubRequest('unsubscribe', channelId, row.secret);
  } catch (err) {
    log.warn('youtube-alerts', `WebSub unsubscribe ${channelId}: ${err.message}`);
    return false;
  }
}

/**
 * Subscribe again every wanted channel whose lease has less than a day left (or was never
 * verified). Fine to call often.
 * @param {number} [now]
 * @param {Set<string>} [only]  when given, leave rows for other channels alone
 * @returns {Promise<string[]>} the channels asked
 */
export async function renewDue(now = Date.now(), only = null) {
  if (!websubEnabled()) return [];
  const rows = (await websubDueBefore(now + RENEW_BEFORE_MS)).filter((r) => !only || only.has(r.channel_id));
  await Promise.all(rows.map((r) => subscribe(r.channel_id)));
  return rows.map((r) => r.channel_id);
}

/** The channels at least one enabled guild alert wants new-video announcements for. */
async function watchedChannels() {
  const out = new Set();
  for (const { config: cfg } of await listEnabledModuleConfigs('youtube-alerts')) {
    for (const alert of normaliseYoutubeConfig(cfg).alerts) {
      if (alert.onVideo && CHANNEL_RE.test(alert.ytChannelId)) out.add(alert.ytChannelId);
    }
  }
  return out;
}

/**
 * Make the table match what guilds watch: subscribe channels that are new, unsubscribe channels
 * nobody watches any more, drop unwanted rows whose lease ran out, and renew what is due. Runs
 * at boot, hourly, and after a config save.
 */
export async function syncSubscriptions(now = Date.now()) {
  if (!websubEnabled()) {
    logOffOnce();
    return;
  }
  const watched = await watchedChannels();
  const rows = new Map((await allWebsub()).map((r) => [r.channel_id, r]));
  // Renew first: a channel subscribed just below has no lease yet and would count as due.
  await renewDue(now, watched);
  const asked = [];
  for (const channelId of watched) {
    if (!rows.get(channelId)?.wanted) asked.push(subscribe(channelId));
  }
  for (const row of rows.values()) {
    if (watched.has(row.channel_id)) continue;
    if (row.wanted) asked.push(unsubscribe(row.channel_id));
    else if (row.lease_expires_at == null || row.lease_expires_at < now) await deleteWebsub(row.channel_id);
    else asked.push(unsubscribe(row.channel_id)); // the hub never verified the unsubscribe: ask again
  }
  await Promise.all(asked);
}

// --- hub verification (GET) -------------------------------------------------

/**
 * Answer the hub's verification request. The challenge to echo, or null (answer 404) unless the
 * mode is subscribe/unsubscribe, the topic is exactly this channel's, and we have a matching
 * pending or known subscription: a wanted row for subscribe, an unwanted one for unsubscribe.
 * A verified subscribe stores the lease; a verified unsubscribe deletes the row.
 * @param {string} channelId
 * @param {Record<string, unknown>} query  the request's query string
 * @returns {Promise<string|null>}
 */
export async function verifyIntent(channelId, query = {}) {
  if (!CHANNEL_RE.test(channelId)) return null;
  const mode = query['hub.mode'];
  const topic = query['hub.topic'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' && mode !== 'unsubscribe') return null;
  if (topic !== topicUrl(channelId)) return null;
  if (typeof challenge !== 'string' || !challenge || challenge.length > MAX_CHALLENGE) return null;

  const row = await getWebsub(channelId);
  if (!row) return null;
  if (mode === 'subscribe') {
    if (!row.wanted) return null;
    const asked = Number.parseInt(String(query['hub.lease_seconds'] ?? ''), 10);
    const seconds = Number.isFinite(asked) && asked > 0 ? asked : LEASE_SECONDS;
    // Anyone can send this request, so the lease is kept to a sane range: a huge value would
    // stop renewals, a tiny one only causes extra ones.
    const lease = Math.min(Math.max(seconds, MIN_LEASE_SECONDS), MAX_LEASE_SECONDS);
    await setWebsubLease(channelId, Date.now() + lease * 1000);
  } else {
    if (row.wanted) return null;
    await deleteWebsub(channelId);
  }
  return challenge;
}

// --- signed pushes (POST) ---------------------------------------------------

const SIGNATURE_RE = /^(sha1|sha256)=([0-9a-f]+)$/i;

/**
 * Does `header` (X-Hub-Signature, `sha1=<hex>` or `sha256=<hex>`, nothing else) match the HMAC of
 * `body` under the subscription secret? Constant-time compare on equal-length buffers.
 * @param {string} secret
 * @param {Buffer} body  the exact bytes received
 * @param {string|undefined} header
 */
export function verifySignature(secret, body, header) {
  const m = SIGNATURE_RE.exec(String(header ?? '').trim());
  if (!m || !secret || !Buffer.isBuffer(body)) return false;
  const expected = createHmac(m[1].toLowerCase(), secret).update(body).digest();
  const given = Buffer.from(m[2], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A verified push: announce the new upload(s) in every guild that watches the channel, through
 * the same announceVideo path polling uses (so posted_keys stops a poll and a push, or a
 * repeated push, from announcing twice). Ignored: deleted-entry notices, an entry for another
 * channel, videos that are not new (YouTube also pushes edits of old videos), and a channel
 * whose first poll has not seeded it yet (the poll seeds without announcing).
 * @returns {Promise<number>} messages sent
 */
export async function handleNotification(channelId, atomXml, now = Date.now()) {
  if (!CHANNEL_RE.test(channelId)) return 0;
  const xml = String(atomXml ?? '');
  // `<at:deleted-entry ref="yt:video:ID" when="...">` carries no <entry>, so it parses to nothing;
  // stated anyway so a later parser change cannot turn a deletion into an announcement.
  if (/<at:deleted-entry[\s>]/i.test(xml) && !/<entry[\s>]/i.test(xml)) return 0;
  if (grab(/<yt:channelId>([^<]+)<\/yt:channelId>/, xml) !== channelId) return 0;

  const entries = parseFeed(xml).filter((e) => e.published > 0 && now - e.published <= MAX_PUSH_AGE_MS);
  if (!entries.length) return 0;

  let sent = 0;
  for (const { guildId, config: cfg } of await listEnabledModuleConfigs('youtube-alerts')) {
    for (const alert of normaliseYoutubeConfig(cfg).alerts) {
      if (alert.ytChannelId !== channelId || !alert.onVideo) continue;
      try {
        if (!(await hasSeenAny(guildId, channelId))) continue;
        for (const entry of [...entries].reverse()) {
          if (await announceVideo(guildId, alert, entry)) sent += 1;
        }
      } catch (err) {
        log.error('youtube-alerts', `push ${channelId}:`, err.message);
      }
    }
  }
  await touchWebsubNotified(channelId, now);
  return sent;
}

// --- schedules --------------------------------------------------------------

// Registered at import, started by startSchedules() (src/index.js): subscribe everything shortly
// after boot, then reconcile and renew hourly.
after('youtube-alerts', BOOT_DELAY_MS, () => syncSubscriptions());
every('youtube-alerts', HOUR_MS, () => syncSubscriptions(), { firstDelayMs: HOUR_MS });
