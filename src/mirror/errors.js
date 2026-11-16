// What a failed call to Fluxer means for the mirror. The engine does not look at the SDK's error classes: it
// asks classifyError() what to do, so a test can throw a plain object with a statusCode.
//
//   rate-limit  Fluxer asked Sylo to slow down: wait `retryAfterMs`, then try the same job again.
//   transient   a network failure or a 5xx: try again later with a growing delay.
//   permission  Sylo is not allowed (401/403): this item fails, and enough of them in a row pause the pair.
//   gone        404: the thing is already gone (for a delete that is success; for an edit, create it again).
//   limit       Fluxer refused because of one of its own limits (too many emoji ...): skip the rest of that kind.
//   item        any other 4xx: this one item cannot be made as asked; the copy goes on with the next.

/** @typedef {'rate-limit' | 'transient' | 'permission' | 'gone' | 'limit' | 'item'} ErrorKind */

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const LIMIT_TEXT =
  /maximum number|limit (has been )?reached|too many (emoji|sticker|role|channel)|no (more )?slots|max(imum)? .*(emoji|sticker|role|channel)/i;

// Fluxer's own codes for "you have reached a limit".
const LIMIT_CODES = new Set(['MAX_EMOJIS', 'MAX_STICKERS', 'MAX_GUILD_ROLES', 'MAX_GUILD_CHANNELS']);

/**
 * Is this error a real "no such thing" answer? Only a 404 (or the SDK's own *_NOT_FOUND code for one) is. A timeout, a
 * 429, a 5xx or a cache miss is not: reading them as "gone" would make a second copy of something that is still there.
 */
export function isNotFound(err) {
  if (!err) return false;
  const status = Number(err.statusCode ?? err.status ?? err.cause?.statusCode ?? 0);
  if (status === 404) return true;
  return /^(ROLE|CHANNEL|EMOJI|STICKER)_NOT_FOUND$/.test(String(err.code ?? ''));
}

/**
 * @param {any} err
 * @returns {{ kind: ErrorKind, retryAfterMs?: number, message: string }}
 */
export function classifyError(err) {
  const message = String(err?.message ?? err ?? 'Unknown error').slice(0, 300);
  if (err instanceof MirrorError) return { kind: err.kind, message };
  const status = Number(err?.statusCode ?? err?.status ?? 0);
  if (status === 429 || typeof err?.retryAfter === 'number') {
    const seconds = Number(err?.retryAfter ?? 1);
    return {
      kind: 'rate-limit',
      retryAfterMs: Math.min(Math.max(Math.ceil(seconds * 1000), 1000), 10 * 60_000),
      message,
    };
  }
  if (status === 401 || status === 403) return { kind: 'permission', message };
  if (isNotFound(err)) return { kind: 'gone', message };
  if (status >= 500) return { kind: 'transient', message };
  if (LIMIT_CODES.has(String(err?.code ?? '').toUpperCase())) return { kind: 'limit', message };
  if (status >= 400) return { kind: LIMIT_TEXT.test(message) ? 'limit' : 'item', message };
  if (
    NETWORK_CODES.has(err?.code) ||
    NETWORK_CODES.has(err?.cause?.code) ||
    /fetch failed|timed? ?out|socket/i.test(message)
  ) {
    return { kind: 'transient', message };
  }
  // Not an API error at all (a bug, a missing guild): do not retry it forever, fail the item.
  return { kind: 'item', message };
}

/** An error the engine raises itself, already classified. */
export class MirrorError extends Error {
  /** @param {ErrorKind} kind */
  constructor(message, kind = 'item') {
    super(message);
    this.name = 'MirrorError';
    this.kind = kind;
  }
}

/**
 * Raised by a job that must not go on until a person has done something (move Sylo's role up on Fluxer): the
 * engine puts the job back, pauses the mirror with this message, and waits for a resume.
 */
export class MirrorPause extends MirrorError {
  /** @param {string} pauseKind what the pause is about (shown to the person, and kept on the pair) */
  constructor(message, pauseKind) {
    super(message, 'item');
    this.name = 'MirrorPause';
    this.pauseKind = pauseKind;
  }
}
