// What a push through Postal Pigeon is about. Pigeon's notification has no text in it, only a
// random reference; the app asks this server for the text with that reference
// (GET /api/mobile/push/events/:ref, src/web/routes/mobile.js). One row per recipient, because
// recipients may see different things: the row belongs to the app token it was made for, and
// goes with it when the token is deleted. Rows expire after two hours (Apple stops trying after
// one) and are purged now and then (src/lib/push.js).
import './apiTokens.js'; // first: this table refers to api_tokens
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS push_events (
    ref        TEXT PRIMARY KEY,
    token_id   TEXT NOT NULL REFERENCES api_tokens (id) ON DELETE CASCADE,
    payload    TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_events_token ON push_events (token_id);
  CREATE INDEX IF NOT EXISTS idx_push_events_expires ON push_events (expires_at);
`);

/** How long a reference can be used, from the moment it was made. */
export const PUSH_EVENT_TTL_MS = 2 * 60 * 60 * 1000;

const s = {
  insert: prepare(`
    INSERT INTO push_events (ref, token_id, payload, created_at, expires_at)
    VALUES (@ref, @tokenId, @payload, @createdAt, @expiresAt)
  `),
  find: prepare('SELECT payload FROM push_events WHERE ref = ? AND token_id = ? AND expires_at > ?'),
  remove: prepare('DELETE FROM push_events WHERE ref = ?'),
  removeOf: prepare('DELETE FROM push_events WHERE token_id = ?'),
  purge: prepare('DELETE FROM push_events WHERE expires_at <= ?'),
};

/**
 * Keep the content of a notification for `ref`, for the app token `tokenId` only.
 * @param {{ ref: string, tokenId: string, payload: object, now?: number, ttlMs?: number }} event
 */
export async function createPushEvent({
  ref,
  tokenId,
  payload,
  now = Date.now(),
  ttlMs = PUSH_EVENT_TTL_MS,
}) {
  await s.insert.run({
    ref,
    tokenId,
    payload: JSON.stringify(payload),
    createdAt: now,
    expiresAt: now + ttlMs,
  });
}

/**
 * The content behind `ref`, when it is this token's and has not expired; otherwise null (the
 * same for unknown, expired and someone else's, so a reference cannot be probed).
 * @returns {Promise<object | null>}
 */
export async function findPushEvent(ref, tokenId, now = Date.now()) {
  const row = await s.find.get(ref, tokenId, now);
  if (!row) return null;
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

/** Forget one reference (the push for it was not sent after all). */
export async function deletePushEvent(ref) {
  await s.remove.run(ref);
}

/** Forget every reference of an app token (it turned push off or registered a new setup). */
export async function deletePushEventsOf(tokenId) {
  await s.removeOf.run(tokenId);
}

/** Delete the expired rows. @returns {Promise<number>} how many */
export async function purgeExpiredPushEvents(now = Date.now()) {
  return (await s.purge.run(now)).changes;
}
