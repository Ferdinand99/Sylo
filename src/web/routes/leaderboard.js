// Public (no-auth) leveling leaderboard for a guild — MEE6-style shareable page.
// Mounted before requireAuth in server.js.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { getGuildModule } from '../../db/modules.js';
import { topMembers, memberCount } from '../../db/leveling.js';
import { levelProgress } from '../../modules/lib/levels.js';

const router = Router();
const PAGE_SIZE = 25;

function notFound(res, message) {
  return res.status(404).render('error', {
    title: 'Leaderboard unavailable',
    heading: 'No leaderboard here',
    message,
  });
}

router.get('/:guildId', async (req, res, next) => {
  try {
    const { guildId } = req.params;
    if (!/^\d{17,20}$/.test(guildId)) return notFound(res, 'Unknown server.');

    const guild = runtime.client?.guilds.cache.get(guildId);
    if (!guild) return notFound(res, 'Sylo is not in that server.');

    const { enabled, config } = getGuildModule(guildId, 'leveling');
    if (!enabled) return notFound(res, 'This server does not have leveling enabled.');
    if (config.publicLeaderboard === false) {
      return notFound(res, 'This server has turned its public leaderboard off.');
    }

    const total = memberCount(guildId);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const offset = (page - 1) * PAGE_SIZE;
    const rows = topMembers(guildId, PAGE_SIZE, offset);

    // One bulk gateway fetch for display names + avatars; fall back per-miss.
    let fetched = new Map();
    if (rows.length) {
      try {
        fetched = await guild.members.fetch({ user: rows.map((r) => r.user_id), time: 10_000 });
      } catch {
        /* GuildMembers intent missing or timeout — degrade to ids */
      }
    }

    const members = await Promise.all(
      rows.map(async (r, i) => {
        let name = null;
        let avatar = null;
        const member = fetched.get(r.user_id);
        if (member) {
          name = member.displayName;
          avatar = member.displayAvatarURL({ size: 64 });
        } else {
          const user = await guild.client.users.fetch(r.user_id).catch(() => null);
          if (user) {
            name = user.globalName || user.username;
            avatar = user.displayAvatarURL({ size: 64 });
          }
        }
        const p = levelProgress(r.xp);
        return {
          rank: offset + i + 1,
          name: name || 'Unknown member',
          avatar,
          left: !member && !name,
          level: r.level,
          xp: r.xp,
          messages: r.messages,
          into: p.into,
          need: p.need,
          pct: Math.round(p.pct * 100),
        };
      })
    );

    res.render('leaderboard', {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      members,
      page,
      pages,
      total,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
