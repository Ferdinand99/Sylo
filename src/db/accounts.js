// Dashboard accounts. One account can hold one identity per chat platform
// (Discord, Fluxer): signing in with either lands on the same account, and
// "connect Fluxer" while signed in links a second identity to the current one.
//
//   accounts            one row per dashboard account — just an id
//   account_identities  one row per (platform, platform user): profile, and the
//                       ids of the guilds that user administers (as guild keys)
//   sessions            server-side sessions; the cookie holds only the session id
//
// The cookie therefore no longer grows with how many servers someone manages (the
// bug class behind issue #163), and the guild lists can live longer than a cookie.
import { randomBytes, randomUUID } from 'node:crypto';
import { prepare, registerPostgresBootstrap } from './driver.js';
import { revokeAccountTokens } from './apiTokens.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS accounts (
    id         TEXT PRIMARY KEY,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_identities (
    platform          TEXT NOT NULL,
    platform_user_id  TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    username          TEXT NOT NULL DEFAULT '',
    avatar            TEXT,
    guild_ids         TEXT NOT NULL DEFAULT '[]',
    guilds_fetched_at BIGINT NOT NULL DEFAULT 0,
    linked_at         BIGINT NOT NULL,
    PRIMARY KEY (platform, platform_user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_account_identities_account ON account_identities (account_id);
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`);

/** The identity is already linked to a different account. */
export class IdentityLinkedError extends Error {
  constructor() {
    super('That account is already linked to another Sylo account.');
    this.name = 'IdentityLinkedError';
  }
}

/** The account already has a different identity on that platform. */
export class PlatformAlreadyLinkedError extends Error {
  constructor(platform) {
    super(`This account already has a ${platform} account linked.`);
    this.name = 'PlatformAlreadyLinkedError';
  }
}

const s = {
  insertAccount: prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)'),
  getIdentity: prepare('SELECT * FROM account_identities WHERE platform = ? AND platform_user_id = ?'),
  identitiesOf: prepare('SELECT * FROM account_identities WHERE account_id = ? ORDER BY linked_at ASC'),
  insertIdentity: prepare(`
    INSERT INTO account_identities
      (platform, platform_user_id, account_id, username, avatar, guild_ids, guilds_fetched_at, linked_at)
    VALUES (@platform, @platformUserId, @accountId, @username, @avatar, @guildIds, @fetchedAt, @linkedAt)
    ON CONFLICT (platform, platform_user_id) DO NOTHING
  `),
  refreshIdentity: prepare(`
    UPDATE account_identities
    SET username = @username, avatar = @avatar, guild_ids = @guildIds, guilds_fetched_at = @fetchedAt
    WHERE platform = @platform AND platform_user_id = @platformUserId
  `),
  setGuilds: prepare(`
    UPDATE account_identities SET guild_ids = ?, guilds_fetched_at = ? WHERE platform = ? AND platform_user_id = ?
  `),
  deleteIdentity: prepare('DELETE FROM account_identities WHERE account_id = ? AND platform = ?'),
  countIdentities: prepare('SELECT COUNT(*) AS n FROM account_identities WHERE account_id = ?'),
  insertSession: prepare('INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  getSession: prepare('SELECT account_id, expires_at FROM sessions WHERE id = ?'),
  deleteSession: prepare('DELETE FROM sessions WHERE id = ?'),
  deleteExpired: prepare('DELETE FROM sessions WHERE expires_at <= ?'),
};

const identityFromRow = (r) => ({
  platform: r.platform,
  platformUserId: r.platform_user_id,
  accountId: r.account_id,
  username: r.username,
  avatar: r.avatar ?? null,
  guildIds: JSON.parse(r.guild_ids || '[]'),
  guildsFetchedAt: Number(r.guilds_fetched_at),
  linkedAt: Number(r.linked_at),
});

const params = (identity) => ({
  platform: identity.platform,
  platformUserId: identity.platformUserId,
  username: String(identity.username ?? '').slice(0, 100),
  avatar: identity.avatar ?? null,
  guildIds: JSON.stringify(identity.guildIds ?? []),
  fetchedAt: Date.now(),
});

/** @returns {Promise<string>} the new account's id */
export async function createAccount() {
  const id = randomUUID();
  await s.insertAccount.run(id, Date.now());
  return id;
}

export async function findIdentity(platform, platformUserId) {
  const row = await s.getIdentity.get(platform, platformUserId);
  return row ? identityFromRow(row) : null;
}

export async function identitiesOf(accountId) {
  return (await s.identitiesOf.all(accountId)).map(identityFromRow);
}

/**
 * Sign in with a platform identity. Reuses the account the identity belongs to
 * and refreshes its profile and guilds; otherwise creates an account for it.
 * @param {{ platform: string, platformUserId: string, username?: string, avatar?: string | null, guildIds?: string[] }} identity
 * @returns {Promise<{ accountId: string, created: boolean }>}
 */
export async function signInIdentity(identity) {
  const existing = await findIdentity(identity.platform, identity.platformUserId);
  if (existing) {
    await s.refreshIdentity.run(params(identity));
    return { accountId: existing.accountId, created: false };
  }
  const accountId = await createAccount();
  await s.insertIdentity.run({ ...params(identity), accountId, linkedAt: Date.now() });
  // A concurrent first sign-in may have won the insert; whoever's row is stored is the account.
  const stored = await findIdentity(identity.platform, identity.platformUserId);
  return { accountId: stored.accountId, created: stored.accountId === accountId };
}

/**
 * Link an identity to an existing account ("connect Fluxer" while signed in).
 * @throws {IdentityLinkedError} when it already belongs to a different account
 * @throws {PlatformAlreadyLinkedError} when the account has another identity on that platform
 */
export async function linkIdentity(accountId, identity) {
  const existing = await findIdentity(identity.platform, identity.platformUserId);
  if (existing && existing.accountId !== accountId) throw new IdentityLinkedError();
  if (existing) {
    await s.refreshIdentity.run(params(identity));
    return;
  }
  const sameKind = (await identitiesOf(accountId)).find((i) => i.platform === identity.platform);
  if (sameKind) throw new PlatformAlreadyLinkedError(identity.platform);
  await s.insertIdentity.run({ ...params(identity), accountId, linkedAt: Date.now() });
}

/**
 * Remove an account's identity on a platform. Never removes the last one. Also signs out every
 * Sylo app device of the account: disconnecting a sign-in is what someone does when that login
 * was lost or shared, so the app sessions it may have started must not outlive it.
 * @returns {Promise<boolean>}
 */
export async function unlinkIdentity(accountId, platform) {
  const { n } = await s.countIdentities.get(accountId);
  if (Number(n) <= 1) return false;
  // Tokens first: if this fails, the identity is still there and nothing is half done.
  await revokeAccountTokens(accountId);
  await s.deleteIdentity.run(accountId, platform);
  return true;
}

export async function setIdentityGuilds(platform, platformUserId, guildIds) {
  await s.setGuilds.run(JSON.stringify(guildIds), Date.now(), platform, platformUserId);
}

// --- sessions ------------------------------------------------------------------

/** @returns {Promise<string>} an unguessable session id */
export async function createSession(accountId, ttlMs) {
  const id = randomBytes(32).toString('base64url');
  const now = Date.now();
  await s.insertSession.run(id, accountId, now, now + ttlMs);
  return id;
}

/** @returns {Promise<{ accountId: string, expiresAt: number } | null>} null when unknown or expired */
export async function getSession(sid) {
  if (!sid || typeof sid !== 'string') return null;
  const row = await s.getSession.get(sid);
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  return { accountId: row.account_id, expiresAt: Number(row.expires_at) };
}

export const deleteSession = async (sid) => s.deleteSession.run(sid);
export const purgeExpiredSessions = async () => (await s.deleteExpired.run(Date.now())).changes;
