// HMAC-signed, self-expiring tokens for public links (verification, appeals).
// The signing key is config.sessionSecret, which always exists.
//
// Each kind of link signs with its own purpose ("verify", "appeal"): the body is the same
// shape ("guild.user.expiry") for both, so without it one kind of link worked as the other.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const mac = (body, purpose) =>
  createHmac('sha256', config.sessionSecret)
    .update(purpose ? `${purpose}\0${body}` : body)
    .digest();

const sameBytes = (a, b) => a.length === b.length && timingSafeEqual(a, b);

/**
 * @param {string[]} parts  data segments (must not contain '.')
 * @param {number} ttlMs
 * @param {{ purpose?: string }} [opts]
 */
export function signToken(parts, ttlMs, { purpose } = {}) {
  const body = [...parts, String(Date.now() + ttlMs)].join('.');
  return `${b64url(body)}.${b64url(mac(body, purpose))}`;
}

/**
 * @param {string} token
 * @param {number} [expectedParts]  reject unless exactly this many data segments
 * @param {{ purpose?: string, acceptLegacy?: boolean }} [opts]  `acceptLegacy`: also accept a
 *   token signed before purposes existed (links already sent that are still valid)
 * @returns {string[] | null}  the original `parts` (without the expiry), or null
 */
export function verifyToken(token, expectedParts, { purpose, acceptLegacy = false } = {}) {
  try {
    const [bodyB64, sigB64] = String(token).split('.');
    if (!bodyB64 || !sigB64) return null;
    const body = unb64url(bodyB64).toString();
    const got = unb64url(sigB64);
    const valid =
      sameBytes(got, mac(body, purpose)) || (acceptLegacy && purpose && sameBytes(got, mac(body)));
    if (!valid) return null;

    const segs = body.split('.');
    const exp = Number(segs.pop());
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    if (expectedParts != null && segs.length !== expectedParts) return null;
    return segs;
  } catch {
    return null;
  }
}
