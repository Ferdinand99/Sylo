// API tokens for the Sylo app, and the one-time codes that the app trades for one.
//
// The app signs in through the normal Discord / Fluxer login in a browser sheet; at the end the
// server hands it a short-lived, single-use code bound to a PKCE challenge (RFC 7636, S256), and
// the app exchanges code + verifier for a long-lived token it sends as `Authorization: Bearer`.
// See internal/mobile-api-plan.md.
//
// Neither a token nor a code is ever stored: only its SHA-256, so a database copy cannot be used
// to act as anyone.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { prepare, registerPostgresBootstrap } from './driver.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    device_name  TEXT NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL,
    last_used_at BIGINT NOT NULL,
    expires_at   BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_api_tokens_account ON api_tokens (account_id);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens (expires_at);
  CREATE TABLE IF NOT EXISTS mobile_codes (
    code_hash  TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    challenge  TEXT NOT NULL,
    expires_at BIGINT NOT NULL
  );
`);

const TOKEN_PREFIX = 'sylo_';
/** How long an app token lives without being used; each use slides it forward. */
export const API_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60_000;
// A token's expiry slides forward with use, but rewriting the row on every request would be a
// write per API call; once an hour is plenty for a 90-day lifetime.
const TOUCH_EVERY_MS = 60 * 60 * 1000;
const MAX_DEVICE_NAME = 100;
// Each sign-in from the app adds a token; past this many the least recently used is signed out,
// so neither the table nor the account page's device list can grow without bound.
const MAX_TOKENS_PER_ACCOUNT = 20;

const s = {
  insertToken: prepare(`
    INSERT INTO api_tokens (id, account_id, token_hash, device_name, created_at, last_used_at, expires_at)
    VALUES (@id, @accountId, @hash, @deviceName, @now, @now, @expiresAt)
  `),
  tokenByHash: prepare('SELECT * FROM api_tokens WHERE token_hash = ?'),
  touch: prepare('UPDATE api_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?'),
  tokensOf: prepare(
    `SELECT * FROM api_tokens WHERE account_id = ? AND expires_at > ?
     ORDER BY last_used_at DESC, created_at DESC LIMIT ${MAX_TOKENS_PER_ACCOUNT}`
  ),
  trimAccount: prepare(`
    DELETE FROM api_tokens WHERE account_id = ? AND id NOT IN (
      SELECT id FROM api_tokens WHERE account_id = ?
      ORDER BY last_used_at DESC, created_at DESC LIMIT ${MAX_TOKENS_PER_ACCOUNT}
    )
  `),
  revoke: prepare('DELETE FROM api_tokens WHERE id = ? AND account_id = ?'),
  revokeHash: prepare('DELETE FROM api_tokens WHERE token_hash = ?'),
  revokeAccount: prepare('DELETE FROM api_tokens WHERE account_id = ?'),
  purgeTokens: prepare('DELETE FROM api_tokens WHERE expires_at <= ?'),
  insertCode: prepare(
    'INSERT INTO mobile_codes (code_hash, account_id, challenge, expires_at) VALUES (?, ?, ?, ?)'
  ),
  // Deleting and reading in one statement makes a code single use even under concurrent redeems.
  takeCode: prepare(
    'DELETE FROM mobile_codes WHERE code_hash = ? RETURNING account_id, challenge, expires_at'
  ),
  purgeCodes: prepare('DELETE FROM mobile_codes WHERE expires_at <= ?'),
};

// A fast hash is the right tool here, not bcrypt/scrypt: every stored value comes from secret()
// (256 random bits from the OS CSPRNG), which cannot be guessed however fast the hash is, and
// the hash is the lookup key on every API call (a salted slow hash could be neither). Slow,
// salted hashing is for low-entropy, person-chosen passwords. Keep secret() at 256 random bits.
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

/** The S256 PKCE challenge for a verifier: base64url(sha256(verifier)). */
export function pkceChallenge(verifier) {
  return createHash('sha256').update(String(verifier)).digest('base64url');
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const tokenFromRow = (r) => ({
  id: r.id,
  accountId: r.account_id,
  deviceName: r.device_name,
  createdAt: Number(r.created_at),
  lastUsedAt: Number(r.last_used_at),
  expiresAt: Number(r.expires_at),
});

// --- tokens --------------------------------------------------------------------------

/**
 * A device name as the app sent it, made safe to show: no control or format characters (a
 * right-to-left override or zero-width space could disguise one device as another in the
 * revoke list), at most 100 characters, never cutting a character in half.
 */
export function cleanDeviceName(name) {
  const clean = String(name ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  return [...clean].slice(0, MAX_DEVICE_NAME).join('').trim();
}

/**
 * Issue a token for an account. The returned `token` is the only time the value exists. Past
 * MAX_TOKENS_PER_ACCOUNT, the account's least recently used tokens are revoked.
 * @returns {Promise<{ id: string, token: string, expiresAt: number }>}
 */
export async function createApiToken(accountId, { deviceName = '', ttlMs }) {
  const token = TOKEN_PREFIX + secret();
  const id = randomUUID();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  await s.insertToken.run({
    id,
    accountId,
    hash: sha256(token),
    deviceName: cleanDeviceName(deviceName),
    now,
    expiresAt,
  });
  await s.trimAccount.run(accountId, accountId);
  return { id, token, expiresAt };
}

/** The live token for a value, or null (unknown, malformed or expired). */
export async function findApiToken(token) {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = await s.tokenByHash.get(sha256(token));
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  return tokenFromRow(row);
}

/**
 * Record a use and slide the expiry forward, unless the last recorded use was under an hour ago.
 * @returns {Promise<boolean>} whether the row was written
 */
export async function touchApiToken(record, { ttlMs, now = Date.now() }) {
  if (now - record.lastUsedAt < TOUCH_EVERY_MS) return false;
  await s.touch.run(now, now + ttlMs, record.id);
  return true;
}

/** An account's live tokens, newest use first, without any secret. */
export async function listApiTokens(accountId) {
  return (await s.tokensOf.all(accountId, Date.now())).map(tokenFromRow);
}

/** Revoke one of the account's own tokens. @returns {Promise<boolean>} */
export async function revokeApiToken(accountId, id) {
  return (await s.revoke.run(id, accountId)).changes > 0;
}

/** Revoke the token with this value (signing out from the app itself). @returns {Promise<boolean>} */
export async function revokeApiTokenValue(token) {
  if (typeof token !== 'string' || !token) return false;
  return (await s.revokeHash.run(sha256(token))).changes > 0;
}

/** Revoke every token an account has (identity unlinked, account removed). */
export async function revokeAccountTokens(accountId) {
  await s.revokeAccount.run(accountId);
}

/** Drop expired tokens and codes. @returns {Promise<number>} expired tokens removed */
export async function purgeExpiredApiTokens() {
  const now = Date.now();
  await s.purgeCodes.run(now);
  return (await s.purgeTokens.run(now)).changes;
}

// --- one-time codes --------------------------------------------------------------------

/**
 * A single-use code for an account, bound to the app's PKCE challenge.
 * @returns {Promise<string>}
 */
export async function createMobileCode(accountId, challenge, { ttlMs = CODE_TTL_MS } = {}) {
  const code = secret();
  await s.insertCode.run(sha256(code), accountId, String(challenge), Date.now() + ttlMs);
  return code;
}

/**
 * Trade a code and the PKCE verifier for the account id. The code is gone after the first
 * attempt, right or wrong, so it cannot be guessed at.
 * @returns {Promise<string | null>}
 */
export async function redeemMobileCode(code, verifier) {
  if (typeof code !== 'string' || !code || typeof verifier !== 'string' || !verifier) {
    if (typeof code === 'string' && code) await s.takeCode.get(sha256(code));
    return null;
  }
  const row = await s.takeCode.get(sha256(code));
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  return sameString(pkceChallenge(verifier), row.challenge) ? row.account_id : null;
}
