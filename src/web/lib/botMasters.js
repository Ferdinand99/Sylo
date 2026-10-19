// Who may change a server's bot-master roles. A bot master may use the whole dashboard, so if
// bot masters could also choose the bot-master roles, one of them could make any role (their
// friends', @everyone-like ones) a bot master. Only the server owner or someone with Manage
// Server, checked live, may change the list; a bot master may still save the rest of the
// settings page as long as the list they send back is the one they were shown.
import { config } from '../../config.js';
import { normaliseBotMasterRoles } from '../../db/guildSettings.js';
import { holdsManageServerLive, userIdForGuild } from '../middleware/auth.js';
import { RoleGrantError } from '../middleware/roleGrants.js';

export const BOT_MASTER_REFUSAL =
  'Only the server owner or someone with Manage Server can change bot master roles.';

/**
 * Should the settings save write the submitted bot-master roles? Throws a RoleGrantError (403)
 * when they differ from `shown` (the list the page showed) and the person may not change them.
 * An unchanged list from someone who may not change it is left alone, not rewritten.
 * @param {import('express').Request} req
 * @param {{ id: string }} guild
 * @param {unknown[]} submitted
 * @param {string[]} shown
 * @returns {Promise<boolean>}
 */
export async function shouldSaveBotMasters(req, guild, submitted, shown) {
  if (!config.authEnabled) return true; // open mode: everyone is the admin
  const next = new Set(normaliseBotMasterRoles(guild.id, submitted));
  const before = new Set(normaliseBotMasterRoles(guild.id, shown));
  const unchanged = next.size === before.size && [...next].every((id) => before.has(id));
  if (await holdsManageServerLive(guild.id, userIdForGuild(req, guild.id))) return true;
  if (unchanged) return false;
  throw new RoleGrantError(BOT_MASTER_REFUSAL);
}
