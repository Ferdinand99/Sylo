// A self-hosted Fluxer instance often sits behind a home connection whose public address changes now and then
// (a DNS name that follows a dynamic IP). Nothing in Sylo or the SDK keeps a resolved address: every new connection
// looks the name up again (getaddrinfo, so the answer is never older than the resolver's TTL), and the gateway URL is
// a name, not an address. What can still go wrong for a moment after the address changed:
//   - the SDK's shared undici pool holds keep-alive sockets to the old address, and
//   - the first look-up after the change can still return the old address (the DNS record or a resolver cache had
//     not caught up yet), so the connect fails with EHOSTUNREACH, ECONNREFUSED, ETIMEDOUT or ENETUNREACH.
// installConnectRetry() wraps the SDK's request so that such a failure drops the pool and tries once more, which
// opens a new connection with a fresh look-up. Only failures while connecting count: the request never reached
// Fluxer, so sending it again cannot do anything twice.
import { RequestManager, closeSharedFetch } from '@fluxerjs/rest';
import { log } from '../lib/log.js';

/** errno codes of a connect that could not reach the address it was given. */
export const CONNECT_ERROR_CODES = new Set(['EHOSTUNREACH', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH']);

const INSTALLED = Symbol.for('sylo.fluxerConnectRetry');

/**
 * The code of a failed connect somewhere in the error's cause chain (the SDK wraps undici's "fetch failed", which
 * wraps the socket error), or null. A socket error counts only when it came from connect(): an ETIMEDOUT on a socket
 * that was already open may mean the request did reach Fluxer.
 * @param {any} err
 * @returns {string | null}
 */
export function connectErrorCode(err) {
  const seen = new Set();
  const queue = [err];
  while (queue.length) {
    const e = queue.shift();
    if (!e || typeof e !== 'object' || seen.has(e) || seen.size > 20) continue;
    seen.add(e);
    if (e.code === 'UND_ERR_CONNECT_TIMEOUT') return e.code;
    if (CONNECT_ERROR_CODES.has(e.code) && (e.syscall === 'connect' || /\bconnect\b/.test(String(e.message)))) {
      return e.code;
    }
    if (e.cause) queue.push(e.cause);
    // Happy eyeballs tries every address and reports them together.
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
  return null;
}

/**
 * Make every Fluxer REST request retry once after a failed connect, with the pooled connections dropped first.
 * Idempotent.
 * @param {{ prototype: { request: Function } }} [Manager]  the SDK's RequestManager (tests pass a fake)
 * @param {{ resetPool?: () => Promise<unknown> }} [opts]
 */
export function installConnectRetry(Manager = RequestManager, { resetPool = closeSharedFetch } = {}) {
  const proto = Manager.prototype;
  if (proto[INSTALLED]) return;
  const original = proto.request;
  proto.request = async function request(method, route, options = {}) {
    try {
      return await original.call(this, method, route, options);
    } catch (err) {
      const code = connectErrorCode(err);
      if (!code || options?.signal?.aborted) throw err;
      log.warn(
        'fluxer',
        `could not connect to Fluxer (${code}) for ${method} ${route}; dropping pooled connections and trying once more with a fresh DNS look-up`
      );
      // closeSharedFetch() forgets the pool at once, before its first await (the next request builds a new one), and
      // lets the old pool finish what it is doing in the background: waiting for it could hold this request up.
      try {
        Promise.resolve(resetPool()).catch(() => {});
      } catch {
        // a pool that cannot be closed is left to its own keep-alive timeout
      }
      return original.call(this, method, route, options);
    }
  };
  Object.defineProperty(proto, INSTALLED, { value: true });
}
