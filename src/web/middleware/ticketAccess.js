// Access guard for the tickets pages: a guild admin (Manage Server / owner) OR
// a member holding one of the module's configured staff roles. Pass-through in
// open mode.
import { allGuildKeys, guildByKey } from '../../platform/platformOf.js';
import { config } from '../../config.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { adminKeysOf, identityFor } from '../lib/accountAuth.js';
import { accountManagesGuildLive, fetchMemberFromGuild } from './auth.js';
import { getGuildModule } from '../../db/modules.js';

function deny(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'No ticket access',
    message: 'You need Manage Server, or a configured staff role, to view tickets here.',
  });
}

/**
 * May this account see a server's tickets? `live` is for app tokens: admin rights are checked
 * through the bot, like requireGuildAdmin does, because a token's sign-in snapshot of guilds is
 * never refreshed and must not outlast lost rights. Shared with push notifications
 * (src/lib/push.js), which go only to people who may read the ticket, and which pass their own
 * `fetchMember` for members the bot has not cached.
 * @returns {Promise<boolean>}
 */
export async function accountMaySeeTickets(account, guildId, { live, fetchMember = fetchMemberFromGuild }) {
  const platform = splitPlatformGuildId(guildId)?.platform ?? 'discord';
  const userId = identityFor(account, platform)?.platformUserId ?? null;
  if (
    live
      ? await accountManagesGuildLive(account, guildId, { fetchMember })
      : adminKeysOf(account, allGuildKeys()).has(guildId)
  ) {
    return true;
  }

  if (!userId) return false; // no identity on this guild's platform: nothing to look up
  const staffRoles = (await getGuildModule(guildId, 'tickets')).config.staffRoles ?? [];
  if (staffRoles.length === 0) return false;

  const guild = guildByKey(guildId);
  if (!guild) return false;
  try {
    const member = await fetchMember(guild, userId);
    if (member?.roles.cache.some((r) => staffRoles.includes(r.id))) return true;
  } catch {
    /* fall through */
  }
  return false;
}

/**
 * Whether the request may use the tickets pages: 'ok', 'login' (not signed in),
 * or 'denied'. Shared by the HTML guard below and the V2 JSON API (v2Staff.js).
 * @returns {Promise<'ok' | 'login' | 'denied'>}
 */
export async function ticketAccessState(req) {
  if (!config.authEnabled) return 'ok';

  if (!req.account) return 'login';
  const ok = await accountMaySeeTickets(req.account, req.params.guildId, { live: Boolean(req.viaToken) });
  return ok ? 'ok' : 'denied';
}

/** @type {import('express').RequestHandler} */
export async function requireTicketAccess(req, res, next) {
  const state = await ticketAccessState(req);
  if (state === 'ok') return next();
  if (state === 'login') {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/login');
  }
  deny(res);
}
