// Tiny in-memory fixed-window rate limiter. Each limiter counts per client (and per mount
// path, for one mounted in several places) and resets every window. Enough for a
// single-process self-hosted app; behind a reverse proxy set `trust proxy` so req.ip is the
// real client.
const buckets = new Map();
// Hard ceiling on tracked clients, so a flood of distinct addresses cannot fill the memory.
const MAX_BUCKETS = 50_000;

let nextLimiterId = 0;

function sweep(now) {
  for (const [key, bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
}

setInterval(() => sweep(Date.now()), 60_000).unref();

/** Expand an IPv6 address to its eight hextets, or null. */
function hextets(ip) {
  const [head, tail = null] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (tail === null && left.length !== 8) return null;
  const fill = Array(8 - left.length - right.length).fill('0');
  const all = tail === null ? left : [...left, ...fill, ...right];
  return all.length === 8 ? all.map((h) => (parseInt(h, 16) || 0).toString(16)) : null;
}

/**
 * Who the limit applies to: the IPv4 address, or an IPv6 client's /64. One IPv6 connection
 * usually has a whole /64 to pick addresses from, so counting single addresses lets a client
 * rotate past any limit.
 */
export function clientKey(req) {
  const ip = String(req.ip ?? '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const h = hextets(ip.toLowerCase());
  return h ? `${h.slice(0, 4).join(':')}::/64` : ip;
}

/**
 * @param {{ windowMs?: number, max?: number, message?: string, keyFn?: (req: import('express').Request) => string }} [opts]
 */
export function rateLimit({
  windowMs = 60_000,
  max = 60,
  message = 'Too many requests — slow down.',
  keyFn,
} = {}) {
  // Each limiter counts on its own: two limiters on one request must not add to each other.
  const id = ++nextLimiterId;
  return function rateLimitMiddleware(req, res, next) {
    // Default: one bucket per mount path per client. An app-level limiter has no mount path,
    // so it counts all of a client's requests together (never per request path: a random path
    // would get a fresh bucket). `keyFn` overrides this — e.g. the GitHub webhook route keys
    // by URL token instead, since every repo's deliveries share GitHub's own small set of
    // egress IPs and an IP-keyed bucket there would let one busy repo rate-limit every other
    // guild's webhook on the same hosted instance.
    const key = `${id}|${keyFn ? keyFn(req) : `${req.baseUrl || ''}|${clientKey(req)}`}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      if (!bucket && buckets.size >= MAX_BUCKETS) {
        sweep(now);
        // Still full: forget the oldest entries (a Map keeps insertion order).
        for (const old of buckets.keys()) {
          if (buckets.size < MAX_BUCKETS) break;
          buckets.delete(old);
        }
      }
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      if (req.originalUrl?.startsWith('/api/')) return res.status(429).json({ error: message });
      return res.status(429).type('text/plain').send(message);
    }
    return next();
  };
}

/**
 * Who a platform action counts against: one server and one person — their account, or the
 * client address without one (open mode).
 */
export function platformActionKey(req) {
  const who = req.account?.id != null ? `account:${req.account.id}` : `client:${clientKey(req)}`;
  return `platform|${req.params?.guildId ?? ''}|${who}`;
}

/**
 * The stricter limit for dashboard actions that call the platform's API: test messages,
 * publishing a message or role menu, locking or unlocking every channel. One shared count per
 * server and person across all of them, and across the classic and the new dashboard, so a
 * script cannot use Sylo to hammer Discord or Fluxer (and get the bot rate-limited there).
 */
export const platformActionLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many messages sent or published on this server — wait a minute and try again.',
  keyFn: platformActionKey,
});

/** Apply `limiter` only to the requests `when` picks (e.g. a publish, not a draft save). */
export const limitWhen = (when, limiter) => (req, res, next) =>
  when(req) ? limiter(req, res, next) : next();
