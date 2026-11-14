// Access guard for the tickets pages: anyone with dashboard access to the server (View may read,
// Inbox and Edit may also reply and close, see access.js), or a member holding one of the module's
// configured staff roles, who may handle tickets like Inbox. Edit in open mode.
import { guildByKey } from '../../platform/platformOf.js';
import { config } from '../../config.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { identityFor } from '../lib/accountAuth.js';
import { fetchMemberFromGuild } from './auth.js';
import { accountGuildAccessDetail, atLeast, checksLive } from './access.js';
import { getGuildModule } from '../../db/modules.js';
import { withoutEveryone } from '../../db/guildSettings.js';

/**
 * The account's level for a server's tickets: its dashboard access level (src/web/middleware/
 * access.js), raised to inbox for a member with one of the tickets module's staff roles. `live` is
 * for app tokens and stale web sessions: admin rights are then checked through the bot, because a
 * token's sign-in snapshot of guilds is never refreshed and must not outlast lost rights.
 * @returns {Promise<import('./access.js').AccessLevel | null>}
 */
export async function accountTicketAccess(
  account,
  guildId,
  { live, fetchMember = fetchMemberFromGuild, write = false }
) {
  const { level, member: known } = await accountGuildAccessDetail(account, guildId, {
    live,
    fetchMember,
    write,
  });
  if (atLeast(level, 'inbox')) return level;

  const platform = splitPlatformGuildId(guildId)?.platform ?? 'discord';
  const userId = identityFor(account, platform)?.platformUserId ?? null;
  if (!userId) return level; // no identity on this guild's platform: nothing to look up
  const stored = (await getGuildModule(guildId, 'tickets')).config.staffRoles;
  const staffRoles = withoutEveryone(guildId, Array.isArray(stored) ? stored : []);
  if (staffRoles.length === 0) return level;

  const guild = guildByKey(guildId);
  if (!guild) return level;
  try {
    const member = known ?? (await fetchMember(guild, userId));
    if (member?.roles.cache.some((r) => staffRoles.includes(r.id))) return 'inbox';
  } catch {
    /* fall through */
  }
  return level;
}

/**
 * May this account handle a server's tickets (inbox or edit)? Push notifications (src/lib/push.js)
 * go only to them, and pass their own `fetchMember` for members the bot has not cached. Someone with
 * View access reads tickets in the dashboard but is not notified.
 * @returns {Promise<boolean>}
 */
export async function accountMaySeeTickets(account, guildId, options) {
  return atLeast(await accountTicketAccess(account, guildId, options), 'inbox');
}

/**
 * The request's level for the tickets pages, or 'login' when not signed in. Used by the tickets
 * router of the V2 JSON API (v2Staff.js), whose routes each check their own level against it.
 * @returns {Promise<import('./access.js').AccessLevel | 'login' | null>}
 */
export async function ticketAccessLevel(req) {
  if (!config.authEnabled) return 'edit';
  if (!req.account) return 'login';
  const key = req.params.guildId;
  return accountTicketAccess(req.account, key, {
    live: checksLive(req, key),
    write: req.method !== 'GET' && req.method !== 'HEAD',
  });
}
