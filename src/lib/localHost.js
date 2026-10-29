// Is a hostname one that only means something on the local network: an IP address typed by hand,
// "localhost", a single-label name, or a .local/.lan/.home/... name? Used by the web server's
// open-mode refusal and by features that need a publicly reachable address (YouTube WebSub).
import { isIP } from 'node:net';
import { isLocalName } from './safeFetch.js';

/**
 * @param {string} host  a hostname without port or brackets, any case
 */
export function isLocalHostname(host) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase();
  if (!h) return false;
  if (isIP(h)) return true;
  return isLocalName(h);
}
