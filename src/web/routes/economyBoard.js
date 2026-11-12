// Public (no-auth) Economy leaderboard for a guild, at /economy/<guildId>: the richest members by
// cash + bank, with the same privacy choices as the Leveling leaderboard: it exists only while the
// module is on and the server has left "Public leaderboard" on, and every reason there is no page
// gives the same answer. Only the total is shown, never the split: cash is what /rob can take, so
// it is not published. Mounted before requireAuth in server.js.
import { Router } from 'express';
import { guildByKey } from '../../platform/platformOf.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import { economySettings, formatNumber, leaderboardPage } from '../../modules/economy.js';
import { notFound, pageProfiles } from './leaderboard.js';

const PAGE_SIZE = 25;

const router = Router();

router.get('/:guildId', async (req, res, next) => {
  try {
    const { guildId } = req.params;
    if (!isPlatformGuildId(guildId)) return notFound(res);
    const guild = guildByKey(guildId);
    if (!guild) return notFound(res);
    const { enabled, config } = await economySettings(guildId);
    if (!enabled || !config.publicLeaderboard) return notFound(res);

    const board = await leaderboardPage(guildId, Number.parseInt(req.query.page, 10) || 1, PAGE_SIZE);
    const profiles = await pageProfiles(
      guild,
      board.rows.map((r) => r.userId)
    );
    const members = board.rows.map((r) => {
      const { name = null, avatar = null, member = false } = profiles.get(r.userId) ?? {};
      return {
        rank: r.rank,
        name: name || 'Unknown member',
        avatar,
        left: !member && !name,
        total: formatNumber(r.total),
      };
    });
    res.render('economy-leaderboard', {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      members,
      page: board.page,
      pages: board.pages,
      total: board.total,
      currency: { name: config.currencyName, emoji: config.currencyEmoji },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
