// The Sylo app authenticates with `Authorization: Bearer sylo_…` (src/db/apiTokens.js). Only the
// JSON API under /api/ accepts it; the HTML dashboard stays cookie-only.

const SCHEME = 'bearer';

/**
 * The bearer token a request carries for the API: a string (possibly empty or bogus) when it
 * sent one to an /api/ path, else null.
 * @param {import('express').Request} req
 */
export function bearerToken(req) {
  // originalUrl, not path: inside a mounted router req.path has lost its /api prefix.
  const path = String(req.originalUrl ?? req.url ?? req.path ?? '').split('?', 1)[0];
  if (!path.startsWith('/api/')) return null;
  // Plain string handling, not a regex: the header is attacker-controlled, and a pattern like
  // /^Bearer[ \t]+(.*)$/ backtracks polynomially on a long run of whitespace.
  const header = String(req.get('authorization') ?? '');
  if (header.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
  const rest = header.slice(SCHEME.length);
  // `Bearer` with nothing after it (an empty token) still counts as presenting one.
  if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null; // e.g. "Bearersylo_…"
  return rest.trim();
}

/** Did this request present an app token (valid or not)? */
export const isTokenRequest = (req) => bearerToken(req) !== null;
