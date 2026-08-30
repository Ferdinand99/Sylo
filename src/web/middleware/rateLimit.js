// Tiny in-memory fixed-window rate limiter. Per (mount path + client IP) counter
// that resets every window. Enough for a single-process self-hosted app; behind
// a reverse proxy set `trust proxy` so req.ip is the real client.
const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.reset <= now) buckets.delete(key);
}, 60_000).unref();

/**
 * @param {{ windowMs?: number, max?: number, message?: string }} [opts]
 */
export function rateLimit({ windowMs = 60_000, max = 60, message = 'Too many requests — slow down.' } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const key = `${req.baseUrl || req.path}|${req.ip}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).type('text/plain').send(message);
    }
    return next();
  };
}
