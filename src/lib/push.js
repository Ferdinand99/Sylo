// Push notifications to the Sylo app for tickets (internal/push-notifications-plan.md).
//
// An instance can push in three ways, chosen per device by what its app token's row holds:
// - Postal Pigeon (PIGEON_URL): the app registered with Pigeon, the Hedgerow push relay, and gave
//   this instance a handle. Nothing readable goes to Pigeon or Apple: the push carries a random
//   reference, and the app fetches the text from GET /api/mobile/push/events/:ref (the content is
//   kept in push_events, src/db/pushEvents.js, for two hours). This is what an app that
//   announces `push-pigeon` in /api/mobile/info uses;
// The two older ways stay for app builds that do not know Pigeon:
// - direct: it holds the app's APNs key (APNS_*, the hosted Sylo); the app gives it its device
//   token and the instance talks to Apple itself;
// - relay: the app registers its device token with the hosted relay itself (PUSH_RELAY_URL,
//   src/web/routes/pushRelay.js, announced in /api/mobile/info) and gives this instance only the
//   relay token, so a self-hosted instance never sees a device token.
// The app token's row holds the device's push setup (src/db/apiTokens.js), so revoking a device
// or signing out ends its notifications at once, and its relay registration is dropped too.
//
// A member's message in a ticket (tickets.js) notifies every device whose account may see that
// server's tickets (accountMaySeeTickets, cached for 2 minutes) and has not muted it. A burst of
// replies is one notification per device per 30 seconds, and a device gets at most 60 an hour
// (6 an hour, 3 at once, through Pigeon: its own limit, which this instance keeps to). Through
// Pigeon the notifications for one ticket also replace each other on the phone (collapse).
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { BUILD } from '../bot/lib/buildInfo.js';
import { log } from './log.js';
import { inc } from './metrics.js';
import { buildApnsPayload, createApnsClient, NOTIFICATION_LIMITS } from './apns.js';
import { createPigeonClient } from './pigeon.js';
import { getAppSetting, setAppSetting } from '../db/appSettings.js';
import {
  createPushEvent,
  deletePushEvent,
  deletePushEventsOf,
  purgeExpiredPushEvents,
} from '../db/pushEvents.js';
import { guildKey } from '../platform/platformOf.js';
import { identitiesOf } from '../db/accounts.js';
import {
  apiTokenPush,
  clearApiTokenPush,
  markApiTokenPigeonProven,
  onApiTokensDeleted,
  pushRecipientTokens,
  setApiTokenPush,
} from '../db/apiTokens.js';
import { accountMaySeeTickets } from '../web/middleware/ticketAccess.js';
import { isOperator } from '../web/lib/accountAuth.js';

const RELAY_PATH = '/api/push-relay/v1';
const RELAY_TIMEOUT_MS = 10_000;
const ACCESS_TTL_MS = 2 * 60_000; // how long an access check is reused
const MEMBER_MISS_TTL_MS = 10 * 60_000; // how long "the bot cannot find this member" is believed
const ACCESS_CONCURRENCY = 5;
const COALESCE_MS = 30_000;
const SENDS_PER_HOUR = 60; // per device, as the relay allows
const HOUR_MS = 60 * 60_000;
// Pigeon allows a handle 6 alerts an hour, in bursts of up to 3. Sylo keeps to the same budget so
// that it is the one to drop a notification, not Pigeon (which would count it against us).
const PIGEON_BURST = 3;
const PIGEON_PER_HOUR = 6;
// A handle Pigeon has never accepted is either a fresh install or junk, and Pigeon counts every
// handle it does not know against the whole instance (20 an hour). So these go slowly.
const UNPROVEN_GAP_MS = 60_000; // across all devices
const UNPROVEN_PER_TOKEN_HOUR = 3;
const UNAVAILABLE_LOG_MS = 60_000;

let sharedApns = null;

/** This instance's APNs client, when it holds the key; also what the relay sends with. */
export function defaultApnsClient() {
  if (!config.apnsEnabled) return null;
  sharedApns ??= createApnsClient({
    keyId: config.apnsKeyId,
    teamId: config.apnsTeamId,
    privateKey: config.apnsPrivateKey,
    topic: config.apnsTopic,
  });
  return sharedApns;
}

// `apns` undefined means "from config"; tests set every field through configurePush().
const settings = {
  relayUrl: config.pushRelayUrl,
  pigeonUrl: config.pigeonUrl,
  pigeon: undefined, // a Pigeon client, instead of the real one (tests)
  apns: undefined,
  fetchImpl: null,
  deliver: null,
  now: Date.now,
};

/**
 * Tests only: swap the relay URL, the Pigeon URL or client, the APNs client (null = none), fetch,
 * the clock, or what delivers one notification to one device.
 */
export function configurePush(overrides) {
  Object.assign(settings, overrides);
}

const apns = () => (settings.apns !== undefined ? settings.apns : defaultApnsClient());
const now = () => settings.now();

let sharedPigeon = null;

/** The Postal Pigeon client: the real one, which keeps its credential in the app settings. */
function pigeon() {
  if (settings.pigeon) return settings.pigeon;
  sharedPigeon ??= createPigeonClient({
    url: () => settings.pigeonUrl,
    store: { get: getAppSetting, set: setAppSetting },
    secret: config.sessionSecret,
    version: BUILD.version,
    fetchImpl: (...args) => (settings.fetchImpl ?? fetch)(...args),
    now: () => settings.now(),
  });
  return sharedPigeon;
}

/** Postal Pigeon's address when this instance pushes through it, otherwise null. */
export const pigeonUrl = () => settings.pigeonUrl || null;

/**
 * Register with Pigeon now, if this instance has not yet, instead of when the first push is sent
 * (so the start-up log shows it). Does nothing without PIGEON_URL. Never throws.
 */
export async function warmUpPigeon() {
  if (pigeonUrl()) await pigeon().ensureRegistered();
}

/**
 * How this instance sends to the older app builds, which do not know Pigeon: directly to Apple
 * (it holds the app's key), through a relay, or not at all (null).
 * @returns {'direct' | 'relay' | null}
 */
export function pushMode() {
  if (apns()) return 'direct';
  return settings.relayUrl ? 'relay' : null;
}

/** Can this instance push at all: the older ways, or Pigeon. */
export const canPush = () => pushMode() !== null || pigeonUrl() !== null;

/** The relay the app registers its device token at, in relay mode; otherwise null. */
export const pushRelayUrl = () => (pushMode() === 'relay' ? settings.relayUrl : null);

// --- in-memory state: caches, coalescing, the per-device cap ----------------------------------

const accessCache = new Map(); // `${accountId}|${guildKey}` -> { ok, at }
const memberMisses = new Map(); // `${guildKey}|${userId}` -> at
const lastNotified = new Map(); // `${tokenId}|${guildKey}:${ticketId}` -> at
const deviceSends = new Map(); // device token -> send times in the last hour
const handleBuckets = new Map(); // Pigeon handle -> { tokens, at }: its budget of alerts
const unprovenSends = new Map(); // app token id -> send times in the last hour (unproven handles)
let lastUnprovenSend = 0;
let lastUnavailableLog = 0;

/** Tests only: forget every cached check, coalescing window and send count. */
export function resetPushState() {
  for (const map of [accessCache, memberMisses, lastNotified, deviceSends, handleBuckets, unprovenSends]) {
    map.clear();
  }
  lastUnprovenSend = 0;
  lastUnavailableLog = 0;
}

setInterval(() => {
  const t = now();
  for (const [k, v] of accessCache) if (t - v.at >= ACCESS_TTL_MS) accessCache.delete(k);
  for (const [k, at] of memberMisses) if (t - at >= MEMBER_MISS_TTL_MS) memberMisses.delete(k);
  for (const [k, at] of lastNotified) if (t - at >= COALESCE_MS) lastNotified.delete(k);
  for (const [k, times] of deviceSends) if (!times.some((at) => t - at < HOUR_MS)) deviceSends.delete(k);
  for (const [k, times] of unprovenSends) if (!times.some((at) => t - at < HOUR_MS)) unprovenSends.delete(k);
  // A budget that has filled up again is the same as none.
  for (const [k, b] of handleBuckets) {
    if (b.tokens + ((t - b.at) * PIGEON_PER_HOUR) / HOUR_MS >= PIGEON_BURST) handleBuckets.delete(k);
  }
  purgeExpiredPushEvents(t).catch((err) =>
    log.debug('push', `purging notification content failed: ${err.message}`)
  );
}, 5 * 60_000).unref();

/** Count a send to a device, unless it already had 60 in the last hour. */
function allowDeviceSend(deviceToken) {
  const t = now();
  const recent = (deviceSends.get(deviceToken) ?? []).filter((at) => t - at < HOUR_MS);
  deviceSends.set(deviceToken, recent);
  if (recent.length >= SENDS_PER_HOUR) return false;
  recent.push(t);
  return true;
}

/** Take one of a Pigeon handle's alerts (6 an hour, up to 3 at once); false when it has none left. */
function allowHandleSend(handle) {
  const t = now();
  const bucket = handleBuckets.get(handle) ?? { tokens: PIGEON_BURST, at: t };
  bucket.tokens = Math.min(PIGEON_BURST, bucket.tokens + ((t - bucket.at) * PIGEON_PER_HOUR) / HOUR_MS);
  bucket.at = t;
  handleBuckets.set(handle, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** May a handle Pigeon never accepted be sent to now: one a minute across all devices, 3 an hour per token. */
function mayAttemptUnprovenSend(tokenId) {
  const t = now();
  if (t - lastUnprovenSend < UNPROVEN_GAP_MS) return false;
  const recent = (unprovenSends.get(tokenId) ?? []).filter((at) => t - at < HOUR_MS);
  unprovenSends.set(tokenId, recent);
  return recent.length < UNPROVEN_PER_TOKEN_HOUR;
}

/** Count a send to an unproven handle (after the handle's own budget agreed to it). */
function noteUnprovenSend(tokenId) {
  const t = now();
  unprovenSends.get(tokenId)?.push(t);
  lastUnprovenSend = t;
}

// --- registration -----------------------------------------------------------------------------

/** A registration the app should hear about: `code` is the API's error string. */
export class PushError extends Error {
  /** @param {'push_unavailable'} code */
  constructor(code, message = code) {
    super(message);
    this.name = 'PushError';
    this.code = code;
  }
}

function relay(path, body) {
  const doFetch = settings.fetchImpl ?? fetch;
  return doFetch(`${settings.relayUrl}${RELAY_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
}

/** Tell the relay to forget a registration. Best effort and never throws: it purges idle ones too. */
async function unregisterAtRelay(relayToken) {
  if (!relayToken || !settings.relayUrl) return;
  try {
    await relay('/unregister', { relayToken });
  } catch (err) {
    log.warn('push', `relay unregister failed: ${err.message}`);
  }
}

// A deleted app token (signed out, revoked, trimmed, expired) takes its relay registration along,
// without making whoever deleted it wait for the relay.
onApiTokensDeleted((relayTokens) => {
  for (const relayToken of relayTokens) void unregisterAtRelay(relayToken);
});

/**
 * Turn push on for an app token, replacing what it had: the Pigeon handle the app got from
 * Postal Pigeon, a device token in direct mode, or the relay token the app registered at the
 * relay in relay mode (the caller checks which one it got).
 * @param {string} tokenId
 * @param {{ deviceToken?: string, relayToken?: string, pigeonHandle?: string,
 *   environment: 'development' | 'production', origin: string }} device  `origin`: this
 *   server's address, the `server` of a notification
 * @throws {PushError}
 */
export async function registerDevice(
  tokenId,
  { deviceToken, relayToken, pigeonHandle, environment, origin }
) {
  const mode = pushMode();
  if (pigeonHandle ? !pigeonUrl() : !mode) throw new PushError('push_unavailable');
  const previous = await apiTokenPush(tokenId);
  if (pigeonHandle) await setApiTokenPush(tokenId, { pigeonHandle, environment, origin });
  else if (mode === 'direct') await setApiTokenPush(tokenId, { deviceToken, environment, origin });
  else await setApiTokenPush(tokenId, { relayToken, environment, origin });
  if (previous?.relayToken && previous.relayToken !== relayToken) void unregisterAtRelay(previous.relayToken);
  if (previous?.pigeonHandle && previous.pigeonHandle !== pigeonHandle) await deletePushEventsOf(tokenId);
}

/**
 * Turn push off for an app token (and unregister it at the relay, best effort, not awaited). A
 * Pigeon handle is revoked by the app itself, at Pigeon.
 */
export async function unregisterDevice(tokenId) {
  const previous = await apiTokenPush(tokenId);
  await clearApiTokenPush(tokenId);
  if (previous?.relayToken) void unregisterAtRelay(previous.relayToken);
  if (previous?.pigeonHandle) await deletePushEventsOf(tokenId);
}

let collapseSecret = null;

/**
 * What Pigeon asks of `collapse`: at most 32 of A-Za-z0-9_-. Notifications of one ticket (or of
 * the dev log) on one device share a value, so they replace each other on the phone. Pigeon sees
 * this value, so it is a keyed hash (HMAC-SHA256, the key derived from SESSION_SECRET for this
 * purpose alone) of the app token and the thread: without the secret nobody can tell which
 * server or ticket it stands for, and two devices of one person get different values.
 * @param {string} tokenId  the recipient's app token
 * @param {string} threadId  `${guildId}:${ticketId}`, or 'devlog'
 */
export function collapseKey(tokenId, threadId) {
  collapseSecret ??= Buffer.from(
    hkdfSync('sha256', String(config.sessionSecret), 'sylo', 'pigeon-collapse', 32)
  );
  return createHmac('sha256', collapseSecret)
    .update(`${tokenId}\0${threadId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** What the app is told about a notification when it asks for the text: no server address. */
function pigeonContent(notification) {
  const data = { ...notification.data };
  delete data.server;
  return {
    title: notification.title,
    ...(notification.subtitle ? { subtitle: notification.subtitle } : {}),
    body: notification.body,
    threadId: notification.threadId,
    kind: data.kind,
    data,
  };
}

/**
 * Send one notification to a device through Postal Pigeon. Pigeon and Apple only ever get the
 * handle, a random reference and a collapse key; the text stays here, behind the reference.
 */
async function deliverViaPigeon(recipient, notification) {
  const handle = recipient.pigeonHandle;
  const proven = recipient.pigeonProvenAt != null;
  if (!proven && !mayAttemptUnprovenSend(recipient.id)) {
    inc('sylo_push_pigeon_total', { result: 'throttled' });
    return 'limited';
  }
  if (!allowHandleSend(handle)) {
    inc('sylo_push_pigeon_total', { result: 'limited' });
    return 'limited';
  }
  if (!proven) noteUnprovenSend(recipient.id);
  const ref = randomBytes(16).toString('base64url');
  await createPushEvent({ ref, tokenId: recipient.id, payload: pigeonContent(notification), now: now() });
  const result = await pigeon().send(handle, {
    ref,
    collapse: collapseKey(recipient.id, notification.threadId),
  });
  inc('sylo_push_pigeon_total', { result: result.status });
  if (result.status === 'accepted' || result.status === 'duplicate') {
    if (!proven) await markApiTokenPigeonProven(recipient.id, handle, now());
    return 'ok';
  }
  await deletePushEvent(ref); // nothing was sent, so nobody will ask for it
  if (result.status === 'gone') {
    await clearApiTokenPush(recipient.id, { pigeonHandle: handle });
    return 'gone';
  }
  // 'limited' is not tried again: the notification is dropped and the app lists tickets when opened.
  if (result.status === 'limited') return 'limited';
  // Unavailable, or a kind Pigeon does not take for this app: once a minute, with no identifiers.
  // Debug only: this also runs for the dev-log notifications, and anything above debug would
  // become a new dev-log entry, and so another notification.
  if (now() - lastUnavailableLog >= UNAVAILABLE_LOG_MS) {
    lastUnavailableLog = now();
    log.debug('push', `Postal Pigeon did not take a notification (${result.reason ?? result.status}).`);
  }
  return 'unavailable';
}

/**
 * Send one notification to one device.
 * @returns {Promise<'ok' | 'gone' | 'limited' | 'unavailable' | 'skipped'>} `gone`: its push setup
 * was cleared; `unavailable`: Pigeon could not be reached or refused (logged)
 * @throws when Apple or the relay failed otherwise
 */
async function deliver(recipient, notification) {
  // A device that gave a Pigeon handle gets its notifications through Pigeon, whatever else this
  // instance can do.
  if (recipient.pigeonHandle && pigeonUrl()) return deliverViaPigeon(recipient, notification);
  const mode = pushMode();
  // Each device is registered for the way the instance sent when it signed up; after a switch
  // it is skipped until the app registers again (it does on every launch).
  if (mode === 'direct' && recipient.deviceToken) {
    if (!allowDeviceSend(recipient.deviceToken)) return 'limited';
    const result = await apns().send({
      deviceToken: recipient.deviceToken,
      environment: recipient.environment,
      payload: buildApnsPayload(notification),
    });
    if (result.status === 'gone') {
      await clearApiTokenPush(recipient.id, { deviceToken: recipient.deviceToken });
      return 'gone';
    }
    if (result.status !== 'ok') throw new Error(`APNs: ${result.reason}`);
    return 'ok';
  }
  if (mode === 'relay' && recipient.relayToken) {
    const res = await relay('/send', { relayToken: recipient.relayToken, notification });
    if (res.status === 410) {
      await clearApiTokenPush(recipient.id, { relayToken: recipient.relayToken });
      return 'gone';
    }
    if (res.status === 429) return 'limited';
    if (!res.ok) throw new Error(`relay: HTTP ${res.status}`);
    return 'ok';
  }
  return 'skipped';
}

// --- the ticket notification ---------------------------------------------------------------

// One line of lock-screen text: no lone surrogates, no format characters (a right-to-left
// override could disguise who wrote), control characters and separators become spaces, and
// whitespace runs collapse. The relay refuses anything else.
const oneLine = (value) =>
  String(value ?? '')
    .toWellFormed()
    .replace(/\p{Cf}/gu, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** At most `max` code points (never half an emoji), ending in "…" when cut. */
export function clip(text, max) {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/** "<member>: <preview>", or "<member> sent an attachment" when there is no text. */
export function ticketBody(member, content) {
  const who = oneLine(member) || 'A member';
  const text = oneLine(content);
  return clip(text ? `${who}: ${text}` : `${who} sent an attachment`, NOTIFICATION_LIMITS.body);
}

/**
 * The notification for a member's message in a ticket, without `data.server` (each device gets
 * the address it registered from).
 */
export function ticketNotification({ guildName, guildId, ticketId, member, content, isNew }) {
  return {
    title: clip(oneLine(guildName) || 'Sylo', NOTIFICATION_LIMITS.title),
    ...(isNew ? { subtitle: 'New ticket' } : {}),
    body: ticketBody(member, content),
    threadId: `${guildId}:${ticketId}`,
    data: { kind: 'ticket', guildId, ticketId },
  };
}

/** `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A member lookup for one round of access checks: the bot's cache, else one platform call per
 * member per round, and none at all for 10 minutes after the member could not be found.
 */
function memberFetcher() {
  const round = new Map();
  return (guild, userId) => {
    const cached = guild.members.cache.get(userId);
    if (cached) return Promise.resolve(cached);
    const key = `${guildKey(guild)}|${userId}`;
    const missedAt = memberMisses.get(key);
    if (missedAt !== undefined && now() - missedAt < MEMBER_MISS_TTL_MS) return Promise.resolve(null);
    if (!round.has(key)) {
      round.set(
        key,
        guild.members.fetch(userId).then(
          (member) => {
            memberMisses.delete(key);
            return member;
          },
          () => {
            memberMisses.set(key, now());
            return null;
          }
        )
      );
    }
    return round.get(key);
  };
}

/**
 * May this account see the server's tickets? Checked fresh while the member is in the bot's
 * cache, which the gateway keeps current (GuildMembers intent on Discord; always on Fluxer), so a
 * lost right counts at the next notification and costs no platform call. Only a check that had
 * to look the member up outside the cache is reused, for 2 minutes. A failed check is a no.
 */
async function accountMayReceive(accountId, key, fetchMember) {
  const cacheKey = `${accountId}|${key}`;
  const hit = accessCache.get(cacheKey);
  if (hit && now() - hit.at < ACCESS_TTL_MS) return hit.ok;
  let lookedOutside = false;
  const lookup = async (guild, userId) => {
    const cached = guild.members.cache.get(userId);
    if (cached) return cached;
    lookedOutside = true;
    return fetchMember(guild, userId);
  };
  let ok;
  try {
    const account = { id: accountId, identities: await identitiesOf(accountId) };
    ok = await accountMaySeeTickets(account, key, { live: true, fetchMember: lookup });
  } catch {
    ok = false;
    lookedOutside = true;
  }
  if (lookedOutside) accessCache.set(cacheKey, { ok, at: now() });
  else accessCache.delete(cacheKey);
  return ok;
}

/**
 * Who a ticket notification for this server goes to: devices with push set up, not muted for
 * it, whose account may see its tickets. One check per account, at most 5 at a time.
 */
export async function ticketRecipients(key, { want = () => true } = {}) {
  const tokens = (await pushRecipientTokens()).filter((t) => !t.mutedServers.includes(key) && want(t));
  const accounts = [...new Set(tokens.map((t) => t.accountId))];
  const fetchMember = memberFetcher();
  const allowed = await mapLimit(accounts, ACCESS_CONCURRENCY, (id) =>
    accountMayReceive(id, key, fetchMember)
  );
  const may = new Set(accounts.filter((_, i) => allowed[i]));
  return tokens.filter((t) => may.has(t.accountId));
}

/**
 * Notify staff devices about a member's message in a ticket (a new ticket, or a reply in an open
 * one). Never throws: tickets.js fires this and forgets it, and a failure is logged once.
 * @param {{ guild: object, ticketId: number, member: string, content: string, isNew: boolean }} activity
 * @returns {Promise<{ sent: number, recipients: string[] }>} for tests: token ids sent to
 */
export async function notifyTicketActivity({ guild, ticketId, member, content, isNew }) {
  const none = { sent: 0, recipients: [] };
  try {
    if (!canPush()) return none;
    const key = guildKey(guild);
    // A new ticket always goes; replies in it coalesce to one per device per 30 seconds. Decided
    // before the access checks, so a burst of replies costs one round of checks.
    const t = now();
    const due = (r) => {
      if (!(r.origin ?? config.dashboardUrl)) return false;
      if (isNew) return true;
      const last = lastNotified.get(`${r.id}|${key}:${ticketId}`);
      return last === undefined || t - last >= COALESCE_MS;
    };
    const targets = await ticketRecipients(key, { want: due });
    if (!targets.length) return none;
    for (const r of targets) lastNotified.set(`${r.id}|${key}:${ticketId}`, t);
    const base = ticketNotification({
      guildName: guild.name,
      guildId: key,
      ticketId,
      member,
      content,
      isNew,
    });
    const send = settings.deliver ?? deliver;
    const results = await Promise.allSettled(
      targets.map((r) =>
        send(r, { ...base, data: { ...base.data, server: r.origin ?? config.dashboardUrl } })
      )
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
      log.warn(
        'push',
        `${failed.length} of ${results.length} ticket notifications failed: ${failed[0].reason?.message ?? failed[0].reason}`
      );
    }
    return {
      sent: results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length,
      recipients: targets.map((r) => r.id),
    };
  } catch (err) {
    log.error('push', 'ticket notification failed:', err.message);
    return none;
  }
}

// --- the dev-log notification ------------------------------------------------------------------

/** "app.sylobot.com" from an instance address, to tell instances apart on a lock screen. */
function hostOf(instance) {
  try {
    return new URL(instance).host;
  } catch {
    return '';
  }
}

/**
 * The notification for one of Sylo's own errors or warnings, for an operator's device. Without
 * `data.server` (each device gets the address it registered from).
 */
export function devLogNotification({ level, scope, message, instance }) {
  const host = hostOf(instance);
  return {
    title: clip(host ? `Sylo dev log · ${host}` : 'Sylo dev log', NOTIFICATION_LIMITS.title),
    subtitle: clip(
      `${level === 'error' ? 'Error' : 'Warning'} · ${oneLine(scope) || 'sylo'}`,
      NOTIFICATION_LIMITS.subtitle
    ),
    body: clip(oneLine(message) || '(no message)', NOTIFICATION_LIMITS.body),
    threadId: 'devlog',
    data: { kind: 'devlog', level: level === 'error' ? 'error' : 'warn' },
  };
}

const wantsDevLog = (choice, level) => choice === 'warnings' || (choice === 'errors' && level === 'error');

/**
 * Notify operators' devices about one dev-log event (src/lib/devLog.js), at the level each
 * device chose. Never throws and never logs through log.js above debug: a failure here must not
 * feed the dev log again.
 * @returns {Promise<{ sent: number, recipients: string[] }>} for tests: token ids sent to
 */
export async function notifyDevLogEvent({ level, scope, message }) {
  const none = { sent: 0, recipients: [] };
  try {
    if (!canPush()) return none;
    const tokens = (await pushRecipientTokens()).filter(
      (t) => wantsDevLog(t.devLog, level) && (t.origin ?? config.dashboardUrl)
    );
    const operators = new Map();
    for (const accountId of new Set(tokens.map((t) => t.accountId))) {
      operators.set(accountId, isOperator({ identities: await identitiesOf(accountId) }));
    }
    const targets = tokens.filter((t) => operators.get(t.accountId));
    const send = settings.deliver ?? deliver;
    const results = await Promise.allSettled(
      targets.map((r) => {
        const server = r.origin ?? config.dashboardUrl;
        const n = devLogNotification({ level, scope, message, instance: server });
        return send(r, { ...n, data: { ...n.data, server } });
      })
    );
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) log.debug('push', `${failed.length} dev-log notifications failed`);
    return {
      sent: results.filter((r) => r.status === 'fulfilled' && r.value === 'ok').length,
      recipients: targets.map((r) => r.id),
    };
  } catch (err) {
    log.debug('push', `dev-log notification failed: ${err.message}`);
    return none;
  }
}
