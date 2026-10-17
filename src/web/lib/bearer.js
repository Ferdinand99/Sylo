// The Sylo app authenticates with `Authorization: Bearer sylo_…` (src/db/apiTokens.js). Only the
// JSON API under /api/ accepts it; the HTML dashboard stays cookie-only.

// `Bearer` with nothing after it (an empty token) still counts as presenting one.
const BEARER = /^Bearer(?:[ \t]+(.*))?$/i;

/**
 * The bearer token a request carries for the API: a string (possibly empty or bogus) when it
 * sent one to an /api/ path, else null.
 * @param {import('express').Request} req
 */
export function bearerToken(req) {
  // originalUrl, not path: inside a mounted router req.path has lost its /api prefix.
  const path = String(req.originalUrl ?? req.url ?? req.path ?? '').split('?', 1)[0];
  if (!path.startsWith('/api/')) return null;
  const match = BEARER.exec(req.get('authorization') ?? '');
  return match ? (match[1] ?? '').trim() : null;
}

/** Did this request present an app token (valid or not)? */
export const isTokenRequest = (req) => bearerToken(req) !== null;
