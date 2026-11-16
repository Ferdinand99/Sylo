// "Only the server owner": the check some actions of the dashboard need, beyond the dashboard access levels
// (src/web/middleware/access.js). Edit access, Administrator and the bot-master roles do not make anyone the
// owner. The owner is read from the platform's own guild object (`ownerId`, kept current by the gateway, see
// bot/lib/adminSnapshot.js), and the answer is worked out on every call, never remembered.
//
// In open mode (no logins: the dashboard is a LAN tool and everyone is "local admin") there is no one to
// compare, so the check passes, as every other access check does there.
import { config } from '../../config.js';
import { guildByKey } from '../../platform/platformOf.js';
import { userIdForGuild } from '../middleware/auth.js';

/** The refusal: an HTTP 403 with a message the dashboard shows as it is. */
export class GuildOwnerError extends Error {
  constructor(message = 'Only the server owner can do this.') {
    super(message);
    this.name = 'GuildOwnerError';
    this.status = 403;
  }
}

/**
 * Is the signed-in person the owner of this server? Their id on the server's own platform is compared with
 * the owner the platform reports; no identity there, an unknown server or an owner that is not known all mean no.
 * @param {import('express').Request} req
 * @param {string} guildKey  the server key
 * @returns {boolean}
 */
export function isGuildOwner(req, guildKey) {
  if (!config.authEnabled) return true;
  const userId = userIdForGuild(req, guildKey);
  const ownerId = guildByKey(guildKey)?.ownerId;
  return Boolean(userId && ownerId && String(userId) === String(ownerId));
}

/**
 * Refuse (GuildOwnerError, 403) unless the signed-in person owns this server.
 * @param {import('express').Request} req
 * @param {string} guildKey  the server key
 * @returns {void}
 */
export function requireGuildOwner(req, guildKey) {
  if (!isGuildOwner(req, guildKey)) throw new GuildOwnerError();
}
