// A small client for Apple Push Notification service (APNs), for the Sylo app's notifications
// (internal/push-notifications-plan.md). Only the hosted Sylo holds an APNs key; self-hosted
// instances send through its relay (src/web/routes/pushRelay.js), which uses this too.
//
// HTTP/2 to api.push.apple.com (production) or api.sandbox.push.apple.com (development builds),
// one reused session per host. Auth is a provider token: an ES256 JWT { iss: team, iat } with the
// key id in its header. Apple rejects one older than an hour and throttles signing a new one more
// often than every 20 minutes, so one is reused for 50 minutes. `connect` is injectable: tests never talk to Apple.
import http2 from 'node:http2';
import { signEs256Jwt } from './appStoreConnect.js';

export const APNS_HOSTS = Object.freeze({
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
});

/** Longest title, subtitle and body of a notification, in code points (server names are ≤ 100). */
export const NOTIFICATION_LIMITS = Object.freeze({ title: 100, subtitle: 100, body: 180 });

const TOKEN_REUSE_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
// Apple's answers that mean this device token will never work again: drop it.
const GONE_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const PROVIDER_TOKEN_REASONS = new Set(['ExpiredProviderToken', 'InvalidProviderToken']);

/**
 * The APNs payload for a notification. The relay builds it too, from the validated fields, so
 * the shape is decided here alone.
 * @param {{ title: string, subtitle?: string, body: string, threadId: string,
 *   data: { kind: string, server: string, guildId: string, ticketId: number } }} n
 */
export function buildApnsPayload(n) {
  const alert = { title: n.title, ...(n.subtitle ? { subtitle: n.subtitle } : {}), body: n.body };
  return {
    aps: { alert, sound: 'default', 'thread-id': n.threadId },
    sylo: { kind: n.data.kind, server: n.data.server, guildId: n.data.guildId, ticketId: n.data.ticketId },
  };
}

/**
 * @typedef {{ status: 'ok' } | { status: 'gone', reason: string } | { status: 'error', reason: string }} ApnsResult
 *   `gone`: the device token is dead (uninstalled app, wrong environment); forget it.
 */

/**
 * @param {{ keyId: string, teamId: string, privateKey: string, topic: string,
 *   connect?: typeof http2.connect, now?: () => number, timeoutMs?: number }} opts
 */
export function createApnsClient({
  keyId,
  teamId,
  privateKey,
  topic,
  connect = http2.connect,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let cached = { token: null, at: 0 };
  const sessions = new Map();

  function providerToken() {
    if (!cached.token || now() - cached.at >= TOKEN_REUSE_MS) {
      const iat = Math.floor(now() / 1000);
      cached = {
        token: signEs256Jwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat }, privateKey),
        at: now(),
      };
    }
    return cached.token;
  }

  // A session that errored, got a GOAWAY or closed is dropped; the next send connects again.
  function sessionFor(origin) {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    const drop = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on('error', drop);
    session.on('goaway', () => {
      drop();
      session.close?.();
    });
    session.on('close', drop);
    // An idle connection to Apple must not keep the process alive on shutdown.
    session.unref?.();
    sessions.set(origin, session);
    return session;
  }

  function request(origin, headers, body) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let session;
      let stream;
      try {
        session = sessionFor(origin);
        stream = session.request(headers);
      } catch (err) {
        finish({ status: 0, error: err });
        return;
      }
      // No answer in time: the connection is presumed dead (a half-open socket would hang every
      // later send too), so it is torn down and the next send connects again.
      timer = setTimeout(() => {
        stream.close?.(http2.constants.NGHTTP2_CANCEL);
        if (sessions.get(origin) === session) sessions.delete(origin);
        session.destroy?.();
        finish({ status: 0, error: new Error('timeout') });
      }, timeoutMs);
      let status = 0;
      const chunks = [];
      stream.on('response', (h) => {
        status = Number(h[':status']);
      });
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => finish({ status, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (err) => finish({ status: 0, error: err }));
      stream.end(body);
    });
  }

  return {
    /**
     * Send one notification. Never throws.
     * @param {{ deviceToken: string, environment: 'development' | 'production', payload: object }} msg
     * @returns {Promise<ApnsResult>}
     */
    async send({ deviceToken, environment, payload }) {
      if (typeof deviceToken !== 'string' || !DEVICE_TOKEN.test(deviceToken)) {
        return { status: 'gone', reason: 'BadDeviceToken' };
      }
      const origin = Object.hasOwn(APNS_HOSTS, environment) ? APNS_HOSTS[environment] : null;
      if (!origin) return { status: 'error', reason: 'unknown environment' };
      let auth;
      try {
        auth = providerToken();
      } catch (err) {
        return { status: 'error', reason: `provider token: ${err.message}` };
      }
      const res = await request(
        origin,
        {
          ':method': 'POST',
          ':path': `/3/device/${deviceToken.toLowerCase()}`,
          authorization: `bearer ${auth}`,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        JSON.stringify(payload)
      );
      if (res.error) return { status: 'error', reason: res.error.message };
      if (res.status === 200) return { status: 'ok' };
      let reason = '';
      try {
        reason = String(JSON.parse(res.body)?.reason ?? '');
      } catch {
        /* not JSON */
      }
      if (res.status === 410 || (res.status === 400 && GONE_REASONS.has(reason))) {
        return { status: 'gone', reason: reason || 'Unregistered' };
      }
      if (res.status === 403 && PROVIDER_TOKEN_REASONS.has(reason)) cached = { token: null, at: 0 };
      return { status: 'error', reason: reason || `HTTP ${res.status}` };
    },

    /** Close every open session (shutdown, tests). */
    close() {
      for (const session of sessions.values()) session.close?.();
      sessions.clear();
    },
  };
}
