// The address of the Postal Pigeon push relay (PIGEON_URL), checked. Kept apart from config.js
// so the check can be tested without loading the whole configuration.
import { BlockList, isIP } from 'node:net';

// Addresses an `http://` Pigeon may live on: this machine and the local network.
const lan = new BlockList();
for (const [net, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
]) {
  lan.addSubnet(net, prefix, 'ipv4');
}
lan.addAddress('::1', 'ipv6');
lan.addSubnet('fc00::', 7, 'ipv6');
lan.addSubnet('fe80::', 10, 'ipv6');

const LOCAL_NAME = /\.(local|lan|home|home\.arpa|internal)$/i;

function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) return lan.check(host, 'ipv4');
  if (family === 6) return lan.check(host, 'ipv6');
  return host === 'localhost' || LOCAL_NAME.test(host);
}

/**
 * A Pigeon address in its canonical form, without a trailing slash: `https`, or `http` for a
 * relay on this machine or the local network. No credentials, query or fragment.
 * @param {unknown} raw
 * @returns {string} the address
 * @throws {Error} with a reason when it is not usable
 */
export function checkPigeonUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('not a URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('it must not contain credentials, a query or a fragment');
  }
  if (!url.hostname) throw new Error('it has no host');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('it must be https (http is only for the local network)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('it must be https (http is only for the local network)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
