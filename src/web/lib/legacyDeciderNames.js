// The names an appeal decided on the dashboard before Sylo stored who decided by id may carry. They were
// written as "<label> (dashboard)", where the label is the signed-in account's stored username (what the
// platform login gave: the global name, else the handle; src/web/lib/accountAuth.js sessionUserLabel).
// So they come from Sylo's own records of the person, never from the handle the platform shows now: a
// handle is not that label, and anyone can pick a handle that equals somebody else's label.
import { findIdentity, identitiesOf } from '../../db/accounts.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { atLeast } from '../middleware/access.js';
import { accountTicketAccess } from '../middleware/ticketAccess.js';
import { log } from '../../lib/log.js';

/**
 * The labels to clear from legacy name-only appeals when this person is erased from a server. Only a
 * person who has a dashboard account, and who holds staff access (Inbox or Edit) in that server now,
 * can have decided an appeal there: nobody else gets a name match at all.
 * @param {string} guildKey  the server's key (platform form)
 * @param {string} userId  their id on that server's platform
 * @returns {Promise<string[]>}
 */
export async function legacyDeciderNames(guildKey, userId) {
  try {
    const platform = splitPlatformGuildId(guildKey)?.platform ?? 'discord';
    const identity = await findIdentity(platform, userId);
    if (!identity) return [];
    const account = { id: identity.accountId, identities: await identitiesOf(identity.accountId) };
    const level = await accountTicketAccess(account, guildKey, { live: true });
    if (!atLeast(level, 'inbox')) return [];
    return account.identities.map((i) => i.username).filter(Boolean);
  } catch (err) {
    log.warn('purge', `could not look up legacy appeal names: ${err.message}`);
    return [];
  }
}
