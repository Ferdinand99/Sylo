// Public (no-auth) leveling leaderboard for a guild — MEE6-style shareable page.
// Reachable at /leaderboard/<guildId> and, when set, at /lb/<vanity-slug>
// (the vanity URL is served directly, not redirected). Mounted before
// requireAuth in server.js.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { getGuildModule } from '../../db/modules.js';
import {
  topMembers,
  memberCount,
  topMembersForPeriod,
  memberCountForPeriod,
  periodKeys,
} from '../../db/leveling.js';
import { levelProgress } from '../../modules/lib/levels.js';
import { guildForVanity } from '../../db/leaderboardVanity.js';

const PAGE_SIZE = 25;

function notFound(res, message) {
  return res.status(404).render('error', {
    title: 'Leaderboard unavailable',
    heading: 'No leaderboard here',
    message,
  });
}

/**
 * Render the public leaderboard for a guild. `canonical` is the stable
 * /leaderboard/<id> path, emitted as <link rel="canonical"> so a vanity URL and
 * the id URL don't get indexed as duplicates.
 */
async function renderLeaderboard(req, res, next, guildId, canonical) {
  try {
    const guild = runtime.client?.guilds.cache.get(guildId);
    if (!guild) return notFound(res, 'Sylo is not in that server.');

    const { enabled, config } = getGuildModule(guildId, 'leveling');
    if (!enabled) return notFound(res, 'This server does not have leveling enabled.');
    if (config.publicLeaderboard === false) {
      return notFound(res, 'This server has turned its public leaderboard off.');
    }

    const period = ['week', 'month'].includes(req.query.period) ? req.query.period : 'all';
    const periodKey = period === 'all' ? null : periodKeys()[period];

    const total = periodKey ? memberCountForPeriod(guildId, periodKey) : memberCount(guildId);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const offset = (page - 1) * PAGE_SIZE;
    const rows = periodKey
      ? topMembersForPeriod(guildId, periodKey, PAGE_SIZE, offset)
      : topMembers(guildId, PAGE_SIZE, offset);

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
        const p = periodKey ? null : levelProgress(r.xp);
        return {
          rank: offset + i + 1,
          name: name || 'Unknown member',
          avatar,
          left: !member && !name,
          level: periodKey ? null : r.level,
          xp: r.xp,
          voiceXp: r.voice_xp ?? 0,
          voiceMinutes: r.voice_minutes ?? 0, // only on all-time rows
          messages: r.messages,
          into: p ? p.into : 0,
          need: p ? p.need : 0,
          pct: p ? Math.round(p.pct * 100) : 0,
        };
      })
    );

    res.render('leaderboard', {
      guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 64 }) },
      members,
      page,
      pages,
      total,
      period,
      canonical: canonical || null,
    });
  } catch (err) {
    next(err);
  }
}

// /leaderboard/<guildId>
const router = Router();
router.get('/:guildId', (req, res, next) => {
  const { guildId } = req.params;
  if (!/^\d{17,20}$/.test(guildId)) return notFound(res, 'Unknown server.');
  return renderLeaderboard(req, res, next, guildId);
});

// /lb/<vanity-slug> — same page, served at the vanity URL.
export const vanityRouter = Router();
vanityRouter.get('/:slug', (req, res, next) => {
  const guildId = guildForVanity(req.params.slug);
  if (!guildId) return notFound(res, 'That leaderboard link is not in use.');
  return renderLeaderboard(req, res, next, guildId, `/leaderboard/${guildId}`);
});

export default router;
