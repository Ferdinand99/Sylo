// Errors that mean "that message, channel, member or role is not there" or "no access, for good",
// for the shapes of both platforms. Discord's DiscordAPIError carries `status` and a numeric `code`;
// Fluxer's errors carry `statusCode` and a string `code`, and a failed lookup is a FluxerError
// with the HTTP error in `cause`. A timeout, a 5xx or a rate limit is neither.

/** Codes that say a message or its channel does not exist: Discord's numbers, Fluxer's strings. */
const MESSAGE_GONE_CODES = [
  10008, // Discord: Unknown Message
  10003, // Discord: Unknown Channel
  'UNKNOWN_MESSAGE',
  'UNKNOWN_CHANNEL',
  'MESSAGE_NOT_FOUND',
  'CHANNEL_NOT_FOUND',
];

/**
 * True when the platform says the thing does not exist: a 404 (Discord's `status`, Fluxer's
 * `statusCode`, also one level down in `cause`, which is where Fluxer puts the HTTP error of a
 * lookup that failed) or one of `codes`. A timeout, a 5xx or a missing permission is not "gone".
 * @param {unknown} err
 * @param {Array<number | string>} [codes]  codes that also mean "not found" for this caller
 */
export function isNotFound(err, codes = [], depth = 0) {
  if (!err || typeof err !== 'object') return false;
  if (err.status === 404 || err.statusCode === 404 || codes.includes(err.code)) return true;
  return depth < 2 && isNotFound(err.cause, codes, depth + 1);
}

/** The platform says this message (or its channel) no longer exists, on Discord or Fluxer. */
export const isMessageGone = (err) => isNotFound(err, MESSAGE_GONE_CODES);

/** The platform refuses for good: no access or no permission (a retry will not help). */
export function isPermissionDenied(err, depth = 0) {
  if (!err || typeof err !== 'object') return false;
  if (err.status === 403 || err.statusCode === 403) return true;
  if ([50001, 50013, 'MISSING_ACCESS', 'MISSING_PERMISSIONS'].includes(err.code)) return true;
  return depth < 2 && isPermissionDenied(err.cause, depth + 1);
}
