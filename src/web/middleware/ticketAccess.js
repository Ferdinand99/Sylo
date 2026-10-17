// Access guard for the tickets pages: a guild admin (Manage Server / owner) OR
// a member holding one of the module's configured staff roles. Pass-through in
// open mode.
import { guildByKey } from '../../platform/platformOf.js';
import { config } from '../../config.js';
import { adminGuildIds, tokenManagesGuild, userIdForGuild } from './auth.js';
import { getGuildModule } from '../../db/modules.js';

function deny(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'No ticket access',
    message: 'You need Manage Server, or a configured staff role, to view tickets here.',
  });
}

/**
 * Whether the request may use the tickets pages: 'ok', 'login' (not signed in),
 * or 'denied'. Shared by the HTML guard below and the V2 JSON API (v2Staff.js).
 * @returns {Promise<'ok' | 'login' | 'denied'>}
 */
export async function ticketAccessState(req) {
  if (!config.authEnabled) return 'ok';

  if (!req.account) return 'login';
  const guildId = req.params.guildId;
  const userId = userIdForGuild(req, guildId);
  // An app (token) request is checked live through the bot, like requireGuildAdmin does: its
  // sign-in snapshot of guilds is never refreshed, so it must not outlast lost rights.
  if (req.viaToken ? await tokenManagesGuild(req, guildId) : adminGuildIds(req).has(guildId)) return 'ok';

  if (!userId) return 'denied'; // no identity on this guild's platform: nothing to look up
  const staffRoles = (await getGuildModule(guildId, 'tickets')).config.staffRoles ?? [];
  if (staffRoles.length === 0) return 'denied';

  const guild = guildByKey(guildId);
  if (!guild) return 'denied';
  try {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.some((r) => staffRoles.includes(r.id))) return 'ok';
  } catch {
    /* fall through */
  }
  return 'denied';
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
