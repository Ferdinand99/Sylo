// Public (no-auth) leveling leaderboard for a guild — MEE6-style shareable page.
// Reachable at /leaderboard/<guildId> and, when set, at /lb/<vanity-slug>
// (the vanity URL is served directly, not redirected). Mounted before
// requireAuth in server.js.
import { guildByKey } from '../../platform/platformOf.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import { Router } from 'express';
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

// Names and avatars of a page's members, for a minute. The page needs no login, and each
// uncached view costs a gateway request plus a REST call per member who left: without this,
// anyone reloading it could spend the bot's Discord budget.
const PROFILE_TTL_MS = 60_000;
const MAX_CACHED_PAGES = 2000;
const profileCache = new Map(); // "guild|user ids" -> { at, profiles: Promise<Map> }

/** @returns {Promise<Map<string, { name: string|null, avatar: string|null, member: boolean }>>} */
function pageProfiles(guild, userIds) {
  const key = `${guild.id}|${userIds.join(',')}`;
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profiles;
  if (profileCache.size >= MAX_CACHED_PAGES) {
    for (const [k, v] of profileCache) if (Date.now() - v.at >= PROFILE_TTL_MS) profileCache.delete(k);
    while (profileCache.size >= MAX_CACHED_PAGES) profileCache.delete(profileCache.keys().next().value);
  }
  const profiles = lookUpProfiles(guild, userIds).catch((err) => {
    profileCache.delete(key);
    throw err;
  });
  profileCache.set(key, { at: Date.now(), profiles });
  return profiles;
}

async function lookUpProfiles(guild, userIds) {
  // One bulk gateway fetch for display names + avatars; fall back per-miss.
  let fetched = new Map();
  if (userIds.length) {
    try {
      fetched = await guild.members.fetch({ user: userIds, time: 10_000 });
    } catch {
      /* GuildMembers intent missing or timeout — degrade to ids */
    }
  }
  const out = new Map();
  for (const id of userIds) {
    const member = fetched.get(id);
    if (member) {
      out.set(id, { name: member.displayName, avatar: member.displayAvatarURL({ size: 64 }), member: true });
      continue;
    }
    const user = await guild.client.users.fetch(id).catch(() => null);
    out.set(id, {
      name: user ? user.globalName || user.username : null,
      avatar: user ? user.displayAvatarURL({ size: 64 }) : null,
      member: false,
    });
  }
  return out;
}

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
    const guild = guildByKey(guildId);
    if (!guild) return notFound(res, 'Sylo is not in that server.');

    const { enabled, config } = await getGuildModule(guildId, 'leveling');
    if (!enabled) return notFound(res, 'This server does not have leveling enabled.');
    if (config.publicLeaderboard === false) {
      return notFound(res, 'This server has turned its public leaderboard off.');
    }

    const period = ['week', 'month'].includes(req.query.period) ? req.query.period : 'all';
    const periodKey = period === 'all' ? null : periodKeys()[period];

    const total = periodKey ? await memberCountForPeriod(guildId, periodKey) : await memberCount(guildId);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const offset = (page - 1) * PAGE_SIZE;
    const rows = periodKey
      ? await topMembersForPeriod(guildId, periodKey, PAGE_SIZE, offset)
      : await topMembers(guildId, PAGE_SIZE, offset);

    const profiles = await pageProfiles(
      guild,
      rows.map((r) => r.user_id)
    );

    const members = await Promise.all(
      rows.map(async (r, i) => {
        const { name = null, avatar = null, member = false } = profiles.get(r.user_id) ?? {};
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
  if (!isPlatformGuildId(guildId)) return notFound(res, 'Unknown server.');
  return renderLeaderboard(req, res, next, guildId);
});

// /lb/<vanity-slug> — same page, served at the vanity URL.
export const vanityRouter = Router();
vanityRouter.get('/:slug', async (req, res, next) => {
  try {
    const guildId = await guildForVanity(req.params.slug);
    if (!guildId) return notFound(res, 'That leaderboard link is not in use.');
    return renderLeaderboard(req, res, next, guildId, `/leaderboard/${guildId}`);
  } catch (err) {
    next(err);
  }
});

export default router;
