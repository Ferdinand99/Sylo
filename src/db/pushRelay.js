// Registrations at the push relay: the hosted Sylo holds the app's APNs key and sends
// notifications for self-hosted instances (internal/push-notifications-plan.md). The app
// registers its device token here for the instance it signed in to and hands that instance only
// the relay token it got back, so a self-hosted instance never sees a device token.
//
// Like app tokens (src/db/apiTokens.js), a relay token is never stored: only its SHA-256. No
// account data lives here, only the device token, its APNs environment and which instance it
// was registered for.
import { createHash, randomBytes } from 'node:crypto';
import { prepare, registerPostgresBootstrap, registerPostgresMigration } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS push_relay_registrations (
    token_hash   TEXT PRIMARY KEY,
    device_token TEXT NOT NULL,
    environment  TEXT NOT NULL,
    instance     TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL,
    sent_at      BIGINT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_push_relay_device ON push_relay_registrations (device_token, instance);
  CREATE INDEX IF NOT EXISTS idx_push_relay_used ON push_relay_registrations (last_used_at);
`);
// Mirrors SQLite migration 50.
registerPostgresMigration(
  50,
  `ALTER TABLE push_relay_registrations ADD COLUMN IF NOT EXISTS sent_at BIGINT;
   UPDATE push_relay_registrations SET sent_at = last_used_at WHERE sent_at IS NULL AND last_used_at > created_at;`
);

const DAY_MS = 24 * 60 * 60 * 1000;
/** A registration nobody has sent through for this long is dropped. */
export const RELAY_IDLE_MS = 90 * DAY_MS;
/** A registration that never sent anything is dropped sooner: nobody is using it. */
export const RELAY_UNUSED_MS = 7 * DAY_MS;
// Registrations per device token (one per instance it signed in to); past this the oldest go, so
// registering in a loop cannot grow the table without bound.
const MAX_PER_DEVICE = 10;

const s = {
  // A device signs in to an instance again (a new app token): its old registration there goes.
  dropDevice: prepare('DELETE FROM push_relay_registrations WHERE device_token = ? AND instance = ?'),
  insert: prepare(`
    INSERT INTO push_relay_registrations (token_hash, device_token, environment, instance, created_at, last_used_at)
    VALUES (@hash, @deviceToken, @environment, @instance, @now, @now)
  `),
  trimDevice: prepare(`
    DELETE FROM push_relay_registrations
    WHERE device_token = @deviceToken AND token_hash <> @hash AND token_hash NOT IN (
      SELECT token_hash FROM push_relay_registrations
      WHERE device_token = @deviceToken AND token_hash <> @hash
      ORDER BY created_at DESC LIMIT ${MAX_PER_DEVICE - 1}
    )
  `),
  byHash: prepare('SELECT * FROM push_relay_registrations WHERE token_hash = ?'),
  touch: prepare(
    'UPDATE push_relay_registrations SET last_used_at = @now, sent_at = @now WHERE token_hash = @id'
  ),
  remove: prepare('DELETE FROM push_relay_registrations WHERE token_hash = ?'),
  purge: prepare(`
    DELETE FROM push_relay_registrations
    WHERE (sent_at IS NULL AND created_at <= @unusedBefore) OR (sent_at IS NOT NULL AND last_used_at <= @idleBefore)
  `),
};

// 256 random bits, so a fast hash is the right lookup key (see the note in apiTokens.js).
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Register a device for an instance, replacing that instance's earlier registration of it. A
 * device keeps at most 10 registrations; the oldest go.
 * @returns {Promise<string>} the relay token; the only time the value exists
 */
export async function createRelayRegistration({ deviceToken, environment, instance }) {
  const relayToken = randomBytes(32).toString('base64url');
  await s.dropDevice.run(deviceToken, instance);
  const hash = sha256(relayToken);
  await s.insert.run({ hash, deviceToken, environment, instance, now: Date.now() });
  await s.trimDevice.run({ deviceToken, hash });
  return relayToken;
}

/** The registration for a relay token, or null. `id` is the stored hash; `sentAt` null until a send. */
export async function findRelayRegistration(relayToken) {
  if (typeof relayToken !== 'string' || !relayToken) return null;
  const row = await s.byHash.get(sha256(relayToken));
  if (!row) return null;
  return {
    id: row.token_hash,
    deviceToken: row.device_token,
    environment: row.environment,
    instance: row.instance,
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    sentAt: row.sent_at == null ? null : Number(row.sent_at),
  };
}

/** Record a send through a registration (keeps it from the purge). */
export async function touchRelayRegistration(id, now = Date.now()) {
  await s.touch.run({ id, now });
}

/** Forget a registration by its stored id (Apple said the device token is gone). */
export async function deleteRelayRegistrationById(id) {
  await s.remove.run(id);
}

/** Forget the registration for a relay token. @returns {Promise<boolean>} */
export async function deleteRelayRegistration(relayToken) {
  if (typeof relayToken !== 'string' || !relayToken) return false;
  return (await s.remove.run(sha256(relayToken))).changes > 0;
}

/**
 * Drop registrations that never sent anything within 7 days, and those without a send for 90.
 * @returns {Promise<number>} how many
 */
export async function purgeStaleRelayRegistrations({ now = Date.now() } = {}) {
  return (await s.purge.run({ unusedBefore: now - RELAY_UNUSED_MS, idleBefore: now - RELAY_IDLE_MS }))
    .changes;
}
