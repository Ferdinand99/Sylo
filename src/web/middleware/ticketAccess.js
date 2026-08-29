// Access guard for the tickets pages: a guild admin (Manage Server / owner) OR
// a member holding one of the module's configured staff roles. Pass-through in
// open mode.
import { config } from '../../config.js';
import { runtime } from '../../runtime.js';
import { adminGuildIds } from './auth.js';
import { getGuildModule } from '../../db/modules.js';

function deny(res) {
  res.status(403).render('error', {
    title: 'Forbidden',
    heading: 'No ticket access',
    message: 'You need Manage Server, or a configured staff role, to view tickets here.',
  });
}

/** @type {import('express').RequestHandler} */
export async function requireTicketAccess(req, res, next) {
  if (!config.authEnabled) return next();

  const userId = req.session?.user?.id;
  if (!userId) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }
  const guildId = req.params.guildId;
  if (adminGuildIds(req).has(guildId)) return next();

  const staffRoles = getGuildModule(guildId, 'tickets').config.staffRoles ?? [];
  if (staffRoles.length === 0) return deny(res);

  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild) return deny(res);
  try {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.some((r) => staffRoles.includes(r.id))) return next();
  } catch {
    /* fall through */
  }
  deny(res);
}
