// Keeps a signed-in person's list of servers they run (account_identities.guild_ids) current
// from the bot's own events, on Discord and Fluxer. The dashboard uses that list to know which
// servers to offer and check; with it kept current here, it never has to send anyone through the
// platform's login again just to refresh it. Access itself is still checked live through the bot
// (src/web/middleware/auth.js), so a list that lags only changes what is offered, not what is
// allowed. Not covered: a role that gains Manage Server for all its members at once; signing in
// again picks that up.
import { setIdentityGuildAdmin } from '../../db/accounts.js';
import { log } from '../../lib/log.js';

/** Does this member run the server: its owner, or Administrator / Manage Server? */
export function runsGuild(guild, member) {
  if (!member) return false;
  if (guild?.ownerId === member.id) return true;
  try {
    return Boolean(member.permissions?.has('Administrator') || member.permissions?.has('ManageGuild'));
  } catch {
    return false;
  }
}

/** A member's rights may have changed: add or remove the server from their list. */
export async function syncAdminSnapshot(platform, guildKey, guild, member) {
  if (!guildKey || !member?.id) return;
  try {
    await setIdentityGuildAdmin(platform, member.id, guildKey, runsGuild(guild, member));
  } catch (err) {
    log.warn('auth', `could not update the server list of ${platform}:${member.id}: ${err.message}`);
  }
}

/** The server has a new owner: they run it now. */
export async function syncNewOwner(platform, guildKey, ownerId) {
  if (!guildKey || !ownerId) return;
  try {
    await setIdentityGuildAdmin(platform, ownerId, guildKey, true);
  } catch (err) {
    log.warn('auth', `could not update the server list of ${platform}:${ownerId}: ${err.message}`);
  }
}
