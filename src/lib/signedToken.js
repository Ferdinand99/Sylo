// HMAC-signed, self-expiring tokens for public links (verification, appeals).
// The signing key is config.sessionSecret, which always exists.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * @param {string[]} parts  data segments (must not contain '.')
 * @param {number} ttlMs
 */
export function signToken(parts, ttlMs) {
  const body = [...parts, String(Date.now() + ttlMs)].join('.');
  const sig = createHmac('sha256', config.sessionSecret).update(body).digest();
  return `${b64url(body)}.${b64url(sig)}`;
}

/**
 * @param {string} token
 * @param {number} [expectedParts]  reject unless exactly this many data segments
 * @returns {string[] | null}  the original `parts` (without the expiry), or null
 */
export function verifyToken(token, expectedParts) {
  try {
    const [bodyB64, sigB64] = String(token).split('.');
    if (!bodyB64 || !sigB64) return null;
    const body = unb64url(bodyB64).toString();
    const expected = createHmac('sha256', config.sessionSecret).update(body).digest();
    const got = unb64url(sigB64);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

    const segs = body.split('.');
    const exp = Number(segs.pop());
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    if (expectedParts != null && segs.length !== expectedParts) return null;
    return segs;
  } catch {
    return null;
  }
}
