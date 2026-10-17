// Fetch a URL that someone typed into the dashboard (an RSS feed, the welcome card background).
//
// The server does the fetch, so without care a server admin could make it reach the host's own
// network: 127.0.0.1, the LAN, or a cloud metadata service at 169.254.169.254. Here every
// connection, including each redirect hop, goes only to public addresses: an IP in the URL is
// checked before connecting, and a name is checked at connect time by the DNS lookup itself, so
// a name that changes its answer between check and connect (DNS rebinding) is refused too. The
// body is read with a byte cap, so a huge response cannot fill the memory.
// ALLOW_PRIVATE_URLS lifts the address check for self-hosted instances that need it.
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { config } from '../config.js';

export class SafeFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64: reaches IPv4 addresses through a gateway
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d), or null. */
function mappedIPv4(ip) {
  let canonical;
  try {
    canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1); // e.g. ::ffff:7f00:1
  } catch {
    return null;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Is this IP address loopback, private, link-local, multicast or otherwise not public? */
export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    return v4 ? blocked.check(v4, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true; // not an address at all: never treat it as public
}

const LOCAL_SUFFIXES = /\.(localhost|local|lan|home|home\.arpa|internal|intranet)$/i;

/** A name that only means something on the local network: no dots, or a local suffix. */
export function isLocalName(host) {
  const h = String(host ?? '').toLowerCase();
  return h === 'localhost' || (!h.includes('.') && !h.includes(':')) || LOCAL_SUFFIXES.test(h);
}

/** dns.lookup that refuses names resolving to a non-public address, at connect time. */
function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new SafeFetchError(`${hostname} resolves to a private address`));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// undici (for a dispatcher with its own DNS lookup) is loaded on first use, so importers that
// only want isPrivateAddress (the web server) do not load it or hold its connections.
let undici = null;
let guardedAgent = null;
let plainAgent = null;
async function client(open) {
  undici ??= await import('undici');
  const dispatcher = open
    ? (plainAgent ??= new undici.Agent())
    : (guardedAgent ??= new undici.Agent({ connect: { lookup: guardedLookup } }));
  return { fetch: undici.fetch, dispatcher };
}

/**
 * @param {string} url
 * @param {{ maxBytes?: number, timeoutMs?: number, maxRedirects?: number, headers?: object, allowPrivate?: boolean }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, url: string, headers: Headers, body: Buffer }>}
 */
export async function safeFetch(
  url,
  { maxBytes = 5 * 1024 * 1024, timeoutMs = 10_000, maxRedirects = 5, headers = {}, allowPrivate } = {}
) {
  const open = allowPrivate ?? config.allowPrivateUrls;
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    let target;
    try {
      target = new URL(current);
    } catch {
      throw new SafeFetchError('Not a valid URL');
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new SafeFetchError('Only http and https URLs can be fetched');
    }
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!open && isIP(host) && isPrivateAddress(host)) {
      throw new SafeFetchError(`${host} is a private address`);
    }

    const { fetch, dispatcher } = await client(open);
    const res = await fetch(target, {
      headers,
      signal,
      redirect: 'manual',
      dispatcher,
    }).catch((err) => {
      throw err?.cause instanceof SafeFetchError ? err.cause : err;
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      if (hop >= maxRedirects) throw new SafeFetchError('Too many redirects');
      current = new URL(res.headers.get('location'), target).href;
      continue;
    }
    const body = await readCapped(res, maxBytes);
    return { status: res.status, ok: res.ok, url: target.href, headers: res.headers, body };
  }
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new SafeFetchError(`Response too large (${declared} bytes)`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new SafeFetchError(`Response too large (over ${maxBytes} bytes)`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
