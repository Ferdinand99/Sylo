// Who a composed message may ping. Sylo posts with its own right to mention roles, so a role in the text
// only notifies when the person who asked could ping it themselves: the server owner, someone with Manage
// Server or Mention Everyone (checked live) may ping any role; everyone else only the roles that are
// mentionable, which is the platform's own rule for a member without Mention Everyone. Other roles in the
// text are shown but silent, and are reported back so the dashboard and the app can say so.
import { config } from '../../config.js';
import { actorHolds } from '../middleware/access.js';
import { holdsManageServerLive, userIdForGuild } from '../middleware/auth.js';

const ROLE_MENTION = /<@&(\d{17,20})>/g;

/**
 * @returns {Promise<{ allowedMentions: object, rolesSilent: string[] }>}
 *   `rolesSilent` are the names of the roles in the text that will not notify.
 */
export async function composedMentionPolicy(req, guild, spec) {
  const ids = [...new Set([...String(spec?.content ?? '').matchAll(ROLE_MENTION)].map((m) => m[1]))];
  const mayAny =
    !config.authEnabled ||
    (await holdsManageServerLive(guild.id, userIdForGuild(req, guild.id))) ||
    (await actorHolds(req, 'MentionEveryone'));
  if (mayAny) return { allowedMentions: { parse: ['users', 'roles'] }, rolesSilent: [] };
  const roles = ids.map((id) => guild.roles.cache.get(id)).filter(Boolean);
  const pingable = roles.filter((r) => r.mentionable === true).map((r) => r.id);
  return {
    allowedMentions: { parse: ['users'], roles: pingable },
    rolesSilent: roles.filter((r) => !pingable.includes(r.id)).map((r) => r.name),
  };
}
