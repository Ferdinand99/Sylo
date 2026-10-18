// The push relay (internal/push-notifications-plan.md). Only the holder of the Sylo app's APNs
// key can talk to Apple, so the hosted Sylo relays notifications for self-hosted instances:
//
//   POST /register   { deviceToken, environment, instance }  -> { relayToken }
//   POST /send       { relayToken, notification }            -> 204 | 410 (gone) | 429
//   POST /unregister { relayToken }                          -> 204
//
// Mounted at /api/push-relay/v1 only when APNS_* is set. No account. The app registers its own
// device token here (an instance never sees it) and gives the instance it signed in to only the
// relay token, which lets that instance send ticket-shaped notifications to that one device,
// rate limited per registration and per device. The relay builds the APNs payload itself from
// the validated fields, with the registration's own instance as the deep link, and keeps no
// copy of them.
import { Router } from 'express';
import { buildApnsPayload, NOTIFICATION_LIMITS } from '../../lib/apns.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import { log } from '../../lib/log.js';
import {
  createRelayRegistration,
  deleteRelayRegistration,
  deleteRelayRegistrationById,
  findRelayRegistration,
  touchRelayRegistration,
} from '../../db/pushRelay.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';

const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const RELAY_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const ENVIRONMENTS = new Set(['development', 'production']);
const MAX_INSTANCE = 300;
const SENDS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Exactly these keys: every one of `required`, nothing outside `allowed`. */
const shaped = (o, required, optional = []) =>
  isObject(o) &&
  required.every((k) => Object.hasOwn(o, k)) &&
  Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
// Lengths in code points, the way the instance cuts them. A notification is one line of text on a
// lock screen: no control or format characters (a right-to-left override could disguise who
// wrote), no line or paragraph separators, no lone surrogates.
const BAD_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const text = (v, max) =>
  typeof v === 'string' && v.length > 0 && v.isWellFormed() && [...v].length <= max && !BAD_TEXT.test(v);

/**
 * An instance's address in normal form: an http(s) origin and optional path, lower-case scheme
 * and host, no default port, credentials, query, fragment or trailing slash.
 */
export function validInstance(value) {
  if (typeof value !== 'string' || value.length > MAX_INSTANCE) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}` === value;
}

/**
 * A notification the relay will send: a ticket, or an operator's dev-log event. Its
 * `data.server` is replaced by the registration's own.
 */
export function validNotification(n) {
  if (!shaped(n, ['title', 'body', 'threadId', 'data'], ['subtitle'])) return false;
  const { data } = n;
  const texts =
    text(n.title, NOTIFICATION_LIMITS.title) &&
    (n.subtitle === undefined || text(n.subtitle, NOTIFICATION_LIMITS.subtitle)) &&
    text(n.body, NOTIFICATION_LIMITS.body);
  if (!texts) return false;
  if (data?.kind === 'devlog') {
    return (
      shaped(data, ['kind', 'server', 'level']) &&
      (data.level === 'error' || data.level === 'warn') &&
      validInstance(data.server) &&
      n.threadId === 'devlog'
    );
  }
  return (
    shaped(data, ['kind', 'server', 'guildId', 'ticketId']) &&
    data.kind === 'ticket' &&
    validInstance(data.server) &&
    isPlatformGuildId(data.guildId) &&
    Number.isSafeInteger(data.ticketId) &&
    data.ticketId > 0 &&
    n.threadId === `${data.guildId}:${data.ticketId}`
  );
}

const invalid = (res) => res.status(400).json({ error: 'invalid_request' });
let routers = 0;

/**
 * @param {{ apns: { send: Function }, now?: () => number,
 *   limits?: { register?: number, send?: number, unregister?: number, newPerHour?: number } }} opts
 *   `limits`: requests per minute per IP for each endpoint; `newPerHour`, new registrations an
 *   hour from all clients together.
 */
export function createPushRelayRouter({ apns, now = Date.now, limits = {} }) {
  const router = Router();
  const id = ++routers;
  const perIp = (name, max) =>
    rateLimit({ windowMs: 60_000, max, keyFn: (req) => `push-relay${id}:${name}|${clientKey(req)}` });

  // Sends in the last hour (a rolling window) per registration and per device token, so one
  // device registered for several instances is capped too. In memory: one process serves the
  // relay, and losing the counts on a restart only gives an hour's grace once.
  const perRegistration = new Map();
  const perDevice = new Map();
  setInterval(() => {
    const since = now() - HOUR_MS;
    for (const map of [perRegistration, perDevice]) {
      for (const [key, times] of map) if (!times.some((t) => t > since)) map.delete(key);
    }
  }, 10 * 60_000).unref();

  const recentIn = (map, key, t) => (map.get(key) ?? []).filter((at) => at > t - HOUR_MS);

  /** Count a send for a registration, unless either window is full. */
  function allowSend(reg) {
    const t = now();
    const byReg = recentIn(perRegistration, reg.id, t);
    const byDevice = recentIn(perDevice, reg.deviceToken, t);
    perRegistration.set(reg.id, byReg);
    perDevice.set(reg.deviceToken, byDevice);
    if (byReg.length >= SENDS_PER_HOUR || byDevice.length >= SENDS_PER_HOUR) return false;
    byReg.push(t);
    byDevice.push(t);
    return true;
  }

  // /register needs no account, so random device tokens could fill the table from many
  // addresses. Real sign-ins are far fewer: cap new registrations an hour across all clients.
  const newPerHour = limits.newPerHour ?? 5000;
  const recentRegistrations = [];

  router.post('/register', perIp('register', limits.register ?? 30), async (req, res, next) => {
    try {
      const t = now();
      while (recentRegistrations.length && recentRegistrations[0] <= t - HOUR_MS) recentRegistrations.shift();
      if (recentRegistrations.length >= newPerHour) {
        res.setHeader('Retry-After', String(Math.ceil((recentRegistrations[0] + HOUR_MS - t) / 1000)));
        return res.status(429).json({ error: 'rate_limited' });
      }
      const body = req.body;
      if (
        !shaped(body, ['deviceToken', 'environment', 'instance']) ||
        typeof body.deviceToken !== 'string' ||
        !DEVICE_TOKEN.test(body.deviceToken) ||
        !ENVIRONMENTS.has(body.environment) ||
        !validInstance(body.instance)
      ) {
        return invalid(res);
      }
      recentRegistrations.push(t);
      const relayToken = await createRelayRegistration({
        deviceToken: body.deviceToken.toLowerCase(),
        environment: body.environment,
        instance: body.instance,
      });
      res.json({ relayToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/send', perIp('send', limits.send ?? 120), async (req, res, next) => {
    try {
      const body = req.body;
      if (!shaped(body, ['relayToken', 'notification']) || !RELAY_TOKEN.test(String(body.relayToken))) {
        return invalid(res);
      }
      const reg = await findRelayRegistration(body.relayToken);
      if (!reg) return res.status(410).json({ error: 'unknown_registration' });
      if (!validNotification(body.notification)) return invalid(res);
      if (!allowSend(reg)) return res.status(429).json({ error: 'rate_limited' });

      // The deep link always points at the instance the app registered for, whatever was sent.
      const { notification } = body;
      const result = await apns.send({
        deviceToken: reg.deviceToken,
        environment: reg.environment,
        payload: buildApnsPayload({ ...notification, data: { ...notification.data, server: reg.instance } }),
      });
      if (result.status === 'gone') {
        await deleteRelayRegistrationById(reg.id);
        return res.status(410).json({ error: 'unknown_registration' });
      }
      if (result.status !== 'ok') {
        log.warn('push', `relay: APNs send failed: ${result.reason}`);
        return res.status(502).json({ error: 'apns_failed' });
      }
      await touchRelayRegistration(reg.id, now());
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/unregister', perIp('unregister', limits.unregister ?? 30), async (req, res, next) => {
    try {
      const body = req.body;
      if (!shaped(body, ['relayToken']) || typeof body.relayToken !== 'string') return invalid(res);
      if (RELAY_TOKEN.test(body.relayToken)) await deleteRelayRegistration(body.relayToken);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
