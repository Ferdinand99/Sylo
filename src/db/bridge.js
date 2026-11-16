// Bridge storage: the links between a Discord channel and a Fluxer channel, the one-time codes that
// start a link, and the map from a message to its copy on the other side.
//
// A link has two sides. Side "a" is the server that asked for the link (it made the code), side "b"
// is the server that accepted it with the code. Each side has its own channel, its own options (what
// leaves THAT server) and its own webhook, so each server controls what it sends and neither side can
// change what the other shares.
//
//   bridge_links      guild_a/channel_a, guild_b/channel_b   server keys (a Discord id, or "fluxer:<id>")
//                     status        active | paused (a server paused it) | failed (stopped by Sylo)
//                     paused_side   'a' or 'b' when status is paused: only that server may resume it
//                     options_x     JSON text, see normaliseOptions in modules/lib/bridgeText.js
//                     hook_x_id / hook_x_token   the webhook Sylo made in that channel. The token is a
//                                   secret: it is stored sealed (AES-256-GCM, lib/seal.js) and never leaves
//                                   this table (the dashboard only gets "has a webhook"). A token that cannot
//                                   be opened reads as empty, and Sylo makes a new webhook.
//                     requested_by_name / accepted_by_name   display names for the audit trail, not user ids
//   bridge_codes      a pending request: only the SHA-256 of the code is stored, it expires, and it is
//                     used up by the first server that accepts it
//   bridge_messages   a_message_id <-> b_message_id for edits, deletes and replies; swept after 30 days
//
// The server keys are in `guild_a` / `guild_b`, not `guild_id`, so purgeBridgeGuild() below deletes by
// either side (the guild-leave purge in purge.js calls it). bridge_codes has a plain guild_id and is in
// GUILD_TABLES.
import { createHash, randomBytes } from 'node:crypto';
import { prepare, registerPostgresBootstrap } from './driver.js';
import { config } from '../config.js';
import { isSealed, open, seal } from '../lib/seal.js';

registerPostgresBootstrap(`
  CREATE TABLE IF NOT EXISTS bridge_links (
    id                SERIAL PRIMARY KEY,
    guild_a           TEXT NOT NULL,
    channel_a         TEXT NOT NULL,
    guild_b           TEXT NOT NULL,
    channel_b         TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active',
    paused_side       TEXT NOT NULL DEFAULT '',
    fail_reason       TEXT NOT NULL DEFAULT '',
    failure_count     INTEGER NOT NULL DEFAULT 0,
    options_a         TEXT NOT NULL DEFAULT '{}',
    options_b         TEXT NOT NULL DEFAULT '{}',
    hook_a_id         TEXT NOT NULL DEFAULT '',
    hook_a_token      TEXT NOT NULL DEFAULT '',
    hook_b_id         TEXT NOT NULL DEFAULT '',
    hook_b_token      TEXT NOT NULL DEFAULT '',
    requested_by_name TEXT NOT NULL DEFAULT '',
    accepted_by_name  TEXT NOT NULL DEFAULT '',
    created_at        BIGINT NOT NULL,
    updated_at        BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_links_a ON bridge_links (guild_a, channel_a);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_links_b ON bridge_links (guild_b, channel_b);
  CREATE INDEX IF NOT EXISTS idx_bridge_links_guild_b ON bridge_links (guild_b);
  CREATE TABLE IF NOT EXISTS bridge_codes (
    id                SERIAL PRIMARY KEY,
    guild_id          TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    code_hash         TEXT NOT NULL,
    options           TEXT NOT NULL DEFAULT '{}',
    requested_by_name TEXT NOT NULL DEFAULT '',
    expires_at        BIGINT NOT NULL,
    created_at        BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_codes_hash ON bridge_codes (code_hash);
  CREATE INDEX IF NOT EXISTS idx_bridge_codes_guild ON bridge_codes (guild_id);
  CREATE TABLE IF NOT EXISTS bridge_messages (
    link_id       INTEGER NOT NULL,
    origin        TEXT NOT NULL,
    a_message_id  TEXT NOT NULL,
    b_message_id  TEXT NOT NULL,
    copy_hook_id  TEXT NOT NULL DEFAULT '',
    content_hash  TEXT NOT NULL DEFAULT '',
    extra         TEXT NOT NULL DEFAULT '{}',
    created_at    BIGINT NOT NULL,
    PRIMARY KEY (link_id, a_message_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_messages_b ON bridge_messages (link_id, b_message_id);
  CREATE INDEX IF NOT EXISTS idx_bridge_messages_created ON bridge_messages (created_at);
`);

/** How long a message map row is kept: the window in which an edit, a delete or a reply still follows. */
export const MESSAGE_MAP_TTL_MS = 30 * 86_400_000;

const s = {
  insertLink: prepare(
    `INSERT INTO bridge_links
       (guild_a, channel_a, guild_b, channel_b, status, options_a, options_b, hook_a_id, hook_a_token,
        hook_b_id, hook_b_token, requested_by_name, accepted_by_name, created_at, updated_at)
     VALUES (@guildA, @channelA, @guildB, @channelB, 'active', @optionsA, @optionsB, @hookAId, @hookAToken,
        @hookBId, @hookBToken, @requestedBy, @acceptedBy, @now, @now)`,
    { returningId: true }
  ),
  link: prepare('SELECT * FROM bridge_links WHERE id = ?'),
  linksOfGuild: prepare('SELECT * FROM bridge_links WHERE guild_a = ? OR guild_b = ? ORDER BY id'),
  linkByChannelA: prepare('SELECT * FROM bridge_links WHERE guild_a = ? AND channel_a = ?'),
  linkByChannelB: prepare('SELECT * FROM bridge_links WHERE guild_b = ? AND channel_b = ?'),
  linkByHook: prepare(
    "SELECT * FROM bridge_links WHERE (hook_a_id = @id AND hook_a_id <> '') OR (hook_b_id = @id AND hook_b_id <> '')"
  ),
  countLinks: prepare('SELECT COUNT(*) AS n FROM bridge_links WHERE guild_a = ? OR guild_b = ?'),
  setStatus: prepare(
    `UPDATE bridge_links SET status = @status, paused_side = @pausedSide, fail_reason = @reason,
       failure_count = @failures, updated_at = @now WHERE id = @id`
  ),
  setOptionsA: prepare('UPDATE bridge_links SET options_a = @options, updated_at = @now WHERE id = @id'),
  setOptionsB: prepare('UPDATE bridge_links SET options_b = @options, updated_at = @now WHERE id = @id'),
  setHookA: prepare(
    'UPDATE bridge_links SET hook_a_id = @id2, hook_a_token = @token, updated_at = @now WHERE id = @id'
  ),
  setHookB: prepare(
    'UPDATE bridge_links SET hook_b_id = @id2, hook_b_token = @token, updated_at = @now WHERE id = @id'
  ),
  delLink: prepare('DELETE FROM bridge_links WHERE id = ?'),
  delLinkMessages: prepare('DELETE FROM bridge_messages WHERE link_id = ?'),
  linkIdsOfGuild: prepare('SELECT id FROM bridge_links WHERE guild_a = ? OR guild_b = ?'),
  delLinksOfGuild: prepare('DELETE FROM bridge_links WHERE guild_a = ? OR guild_b = ?'),

  insertCode: prepare(
    `INSERT INTO bridge_codes (guild_id, channel_id, code_hash, options, requested_by_name, expires_at, created_at)
     VALUES (@guildId, @channelId, @hash, @options, @requestedBy, @expiresAt, @now)`,
    { returningId: true }
  ),
  codeByHash: prepare('SELECT * FROM bridge_codes WHERE code_hash = ? AND expires_at > ?'),
  codesOfGuild: prepare(
    'SELECT id, guild_id, channel_id, requested_by_name, expires_at, created_at FROM bridge_codes WHERE guild_id = ? AND expires_at > ? ORDER BY id'
  ),
  countCodes: prepare('SELECT COUNT(*) AS n FROM bridge_codes WHERE guild_id = ? AND expires_at > ?'),
  codeChannel: prepare(
    'SELECT id FROM bridge_codes WHERE guild_id = ? AND channel_id = ? AND expires_at > ?'
  ),
  delCode: prepare('DELETE FROM bridge_codes WHERE id = ?'),
  delCodeOfGuild: prepare('DELETE FROM bridge_codes WHERE id = ? AND guild_id = ?'),
  delExpiredCodes: prepare('DELETE FROM bridge_codes WHERE expires_at <= ?'),

  insertMap: prepare(
    `INSERT INTO bridge_messages (link_id, origin, a_message_id, b_message_id, copy_hook_id, content_hash, extra, created_at)
     VALUES (@linkId, @origin, @aId, @bId, @hookId, @hash, @extra, @now)
     ON CONFLICT (link_id, a_message_id) DO UPDATE SET
       origin = excluded.origin, b_message_id = excluded.b_message_id,
       copy_hook_id = excluded.copy_hook_id, content_hash = excluded.content_hash,
       extra = excluded.extra`
  ),
  mapByA: prepare('SELECT * FROM bridge_messages WHERE link_id = ? AND a_message_id = ?'),
  mapByB: prepare('SELECT * FROM bridge_messages WHERE link_id = ? AND b_message_id = ?'),
  setHash: prepare(
    'UPDATE bridge_messages SET content_hash = ? WHERE link_id = ? AND a_message_id = ? AND b_message_id = ?'
  ),
  delMapByA: prepare('DELETE FROM bridge_messages WHERE link_id = ? AND a_message_id = ?'),
  delMapByB: prepare('DELETE FROM bridge_messages WHERE link_id = ? AND b_message_id = ?'),
  sweepMap: prepare('DELETE FROM bridge_messages WHERE created_at < ?'),
  countMap: prepare('SELECT COUNT(*) AS n FROM bridge_messages WHERE link_id = ?'),
};

// --- links -----------------------------------------------------------------------------------------

// A webhook token is a bearer credential for the channel, so it is sealed in the table. A value stored
// before sealing (it has no v1. prefix) is read as it is.
const TOKEN_PURPOSE = 'bridge-webhook';
const sealToken = (token) => (token ? seal(config.sessionSecret, TOKEN_PURPOSE, token) : '');
const openToken = (stored) => {
  if (!stored) return '';
  return isSealed(stored) ? (open(config.sessionSecret, TOKEN_PURPOSE, stored) ?? '') : stored;
};

const parseJson = (text) => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

/** A stored row as the code uses it (numbers as numbers, options parsed). */
export function linkFrom(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildA: row.guild_a,
    channelA: row.channel_a,
    guildB: row.guild_b,
    channelB: row.channel_b,
    status: row.status,
    pausedSide: row.paused_side || '',
    failReason: row.fail_reason || '',
    failureCount: Number(row.failure_count) || 0,
    optionsA: parseJson(row.options_a),
    optionsB: parseJson(row.options_b),
    hookAId: row.hook_a_id || '',
    hookAToken: openToken(row.hook_a_token),
    hookBId: row.hook_b_id || '',
    hookBToken: openToken(row.hook_b_token),
    requestedBy: row.requested_by_name || '',
    acceptedBy: row.accepted_by_name || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Create a link. Returns its id, or null when either channel is already in a link (the unique indexes
 * decide, so two requests that race cannot both win).
 * @param {{ guildA: string, channelA: string, guildB: string, channelB: string, optionsA?: object,
 *   optionsB?: object, hookA?: { id: string, token: string }, hookB?: { id: string, token: string },
 *   requestedBy?: string, acceptedBy?: string }} link
 */
export async function createLink(link) {
  try {
    const res = await s.insertLink.run({
      guildA: link.guildA,
      channelA: link.channelA,
      guildB: link.guildB,
      channelB: link.channelB,
      optionsA: JSON.stringify(link.optionsA ?? {}),
      optionsB: JSON.stringify(link.optionsB ?? {}),
      hookAId: link.hookA?.id ?? '',
      hookAToken: sealToken(link.hookA?.token),
      hookBId: link.hookB?.id ?? '',
      hookBToken: sealToken(link.hookB?.token),
      requestedBy: String(link.requestedBy ?? '').slice(0, 100),
      acceptedBy: String(link.acceptedBy ?? '').slice(0, 100),
      now: Date.now(),
    });
    return Number(res.lastInsertRowid);
  } catch (err) {
    if (/unique|duplicate/i.test(String(err?.message ?? err))) return null;
    throw err;
  }
}

export const getLink = async (id) => linkFrom(await s.link.get(Number(id)));
export const linksOfGuild = async (key) => (await s.linksOfGuild.all(key, key)).map(linkFrom);
export const linkCount = async (key) => Number((await s.countLinks.get(key, key)).n);

/**
 * The link a channel is in and which side the channel is, or null.
 * @returns {Promise<{ link: ReturnType<typeof linkFrom>, side: 'a' | 'b' } | null>}
 */
export async function linkForChannel(guildKey, channelId) {
  const a = await s.linkByChannelA.get(guildKey, channelId);
  if (a) return { link: linkFrom(a), side: 'a' };
  const b = await s.linkByChannelB.get(guildKey, channelId);
  if (b) return { link: linkFrom(b), side: 'b' };
  return null;
}

/** The link that owns a webhook id (one of Sylo's bridge webhooks), or null. */
export async function linkForHook(hookId) {
  if (!hookId) return null;
  return linkFrom(await s.linkByHook.get({ id: String(hookId) }));
}

export const STATUSES = Object.freeze(['active', 'paused', 'failed']);

/** Change the state of a link. `pausedSide` only means something while paused. */
export async function setLinkStatus(id, { status, pausedSide = '', reason = '', failures = 0 }) {
  await s.setStatus.run({
    id: Number(id),
    status,
    pausedSide: status === 'paused' ? pausedSide : '',
    reason: String(reason).slice(0, 300),
    failures,
    now: Date.now(),
  });
}

export const setLinkOptions = (id, side, options) =>
  (side === 'a' ? s.setOptionsA : s.setOptionsB).run({
    id: Number(id),
    options: JSON.stringify(options ?? {}),
    now: Date.now(),
  });

/** Store the webhook of one side (after Sylo made a new one). */
export const setLinkHook = (id, side, hook) =>
  (side === 'a' ? s.setHookA : s.setHookB).run({
    id: Number(id),
    id2: hook?.id ?? '',
    token: sealToken(hook?.token),
    now: Date.now(),
  });

/** Delete a link and every message-map row of it. */
export async function deleteLink(id) {
  await s.delLinkMessages.run(Number(id));
  return (await s.delLink.run(Number(id))).changes;
}

/**
 * Delete every link a server is in, with the message maps of them. For the guild-leave purge and
 * /forget-style erasure. Returns the removed links so the caller can tell the other side.
 */
export async function purgeBridgeGuild(key) {
  const ids = (await s.linkIdsOfGuild.all(key, key)).map((r) => Number(r.id));
  for (const id of ids) await s.delLinkMessages.run(id);
  await s.delLinksOfGuild.run(key, key);
  return ids.length;
}

// --- codes -----------------------------------------------------------------------------------------

/** No 0/O/1/I/L: a code read out loud or copied by hand is not mistaken. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 12;
export const CODE_TTL_MS = 15 * 60_000;

/** A new random code, shown as XXXX-XXXX-XXXX (12 characters of a 31-letter alphabet: about 59 bits). */
export function newCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    if (i % 4 === 3 && i < CODE_LENGTH - 1) out += '-';
  }
  return out;
}

/** The text of a code as typed: upper-case, without dashes or spaces. */
export function normaliseCode(text) {
  return String(text ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

// Only the hash is stored; the code itself is shown once, when it is made.
const hashOf = (text) =>
  createHash('sha256')
    .update(`sylo-bridge-code:${normaliseCode(text)}`)
    .digest('hex');

const CODE_SHAPE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** Is this text the right shape for a code (checked before any database lookup)? */
export const looksLikeCode = (text) => CODE_SHAPE.test(normaliseCode(text));

/**
 * Store a new request and return the code (shown once: only its hash is kept).
 * @returns {Promise<{ id: number, code: string, expiresAt: number }>}
 */
export async function createCode({
  guildId,
  channelId,
  options = {},
  requestedBy = '',
  ttlMs = CODE_TTL_MS,
}) {
  const now = Date.now();
  const code = newCode();
  const res = await s.insertCode.run({
    guildId,
    channelId,
    hash: hashOf(code),
    options: JSON.stringify(options),
    requestedBy: String(requestedBy).slice(0, 100),
    expiresAt: now + ttlMs,
    now,
  });
  return { id: Number(res.lastInsertRowid), code, expiresAt: now + ttlMs };
}

/**
 * Use a code up: returns the request it belonged to, or null when it is unknown, expired or already
 * used. The DELETE decides who gets it, so two servers accepting at once cannot both succeed.
 */
export async function claimCode(text, now = Date.now()) {
  if (!looksLikeCode(text)) return null;
  const row = await s.codeByHash.get(hashOf(text), now);
  if (!row) return null;
  if ((await s.delCode.run(row.id)).changes !== 1) return null;
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    options: parseJson(row.options),
    requestedBy: row.requested_by_name,
    expiresAt: Number(row.expires_at),
  };
}

export async function pendingCodes(guildId, now = Date.now()) {
  return (await s.codesOfGuild.all(guildId, now)).map((r) => ({
    id: Number(r.id),
    channelId: r.channel_id,
    requestedBy: r.requested_by_name,
    expiresAt: Number(r.expires_at),
    createdAt: Number(r.created_at),
  }));
}

export const pendingCodeCount = async (guildId, now = Date.now()) =>
  Number((await s.countCodes.get(guildId, now)).n);

/** Is a request for this channel already waiting? */
export const channelHasPendingCode = async (guildId, channelId, now = Date.now()) =>
  Boolean(await s.codeChannel.get(guildId, channelId, now));

/** Cancel one of a server's own requests. @returns {Promise<boolean>} */
export async function cancelCode(guildId, id) {
  return (await s.delCodeOfGuild.run(Number(id), guildId)).changes === 1;
}

/** Drop requests past their time (the daily retention sweep). */
export const sweepCodes = async (now = Date.now()) => (await s.delExpiredCodes.run(now)).changes;

// --- the message map -------------------------------------------------------------------------------

/**
 * Remember that a message on one side has a copy on the other.
 * @param {number} linkId
 * @param {'a' | 'b'} origin  the side the ORIGINAL message was on
 * @param {{ sourceId: string, copyId: string, hookId?: string, hash?: string }} ids
 */
export async function saveMapping(linkId, origin, { sourceId, copyId, hookId = '', hash = '', extra = {} }) {
  await s.insertMap.run({
    linkId: Number(linkId),
    origin,
    aId: origin === 'a' ? sourceId : copyId,
    bId: origin === 'a' ? copyId : sourceId,
    hookId,
    hash,
    extra: JSON.stringify(extra ?? {}).slice(0, 4000),
    now: Date.now(),
  });
}

const mapFrom = (row) =>
  row && {
    linkId: Number(row.link_id),
    origin: row.origin,
    aMessageId: row.a_message_id,
    bMessageId: row.b_message_id,
    copyHookId: row.copy_hook_id || '',
    contentHash: row.content_hash || '',
    extra: parseJson(row.extra),
    createdAt: Number(row.created_at),
  };

/**
 * The mapping a message on `side` takes part in, whether it is the original or the copy, with the id
 * of its counterpart on the other side. Null when it is not mapped (older than the map, or never relayed).
 * @returns {Promise<(NonNullable<ReturnType<typeof mapFrom>> & { counterpartId: string, isOriginal: boolean }) | null>}
 */
export async function mappingOf(linkId, side, messageId) {
  const row = mapFrom(await (side === 'a' ? s.mapByA : s.mapByB).get(Number(linkId), String(messageId)));
  if (!row) return null;
  return {
    ...row,
    counterpartId: side === 'a' ? row.bMessageId : row.aMessageId,
    isOriginal: row.origin === side,
  };
}

export const setMappingHash = (linkId, aId, bId, hash) => s.setHash.run(hash, Number(linkId), aId, bId);

/** Read a request by its code without using it up (the accepting server's checks run before the claim). */
export async function peekCode(text, now = Date.now()) {
  if (!looksLikeCode(text)) return null;
  const row = await s.codeByHash.get(hashOf(text), now);
  if (!row) return null;
  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    options: parseJson(row.options),
    requestedBy: row.requested_by_name,
    expiresAt: Number(row.expires_at),
  };
}

/** Forget a message's mapping (its original was deleted). */
export const deleteMapping = (linkId, side, messageId) =>
  (side === 'a' ? s.delMapByA : s.delMapByB).run(Number(linkId), String(messageId));

export const mappingCount = async (linkId) => Number((await s.countMap.get(Number(linkId))).n);

/** Delete map rows older than the retention window (the daily sweep in retention.js). */
export const sweepMappings = async (now = Date.now()) =>
  (await s.sweepMap.run(now - MESSAGE_MAP_TTL_MS)).changes;
