// Server statistics: keeps chosen voice channels named with a live count
// (e.g. "Members: 1,234"). Not event-driven — a slow refresh loop, because
// Discord rate-limits channel renames hard (~2 per 10 minutes per channel).
import { runtime } from '../runtime.js';
import { getGuildModule } from '../db/modules.js';

/** [type, label] — {count} in the template is replaced with this number. */
export const STAT_TYPES = [
  ['members', 'Members (total)'],
  ['humans', 'Humans (non-bots)'],
  ['bots', 'Bots'],
  ['roles', 'Roles'],
  ['channels', 'Channels'],
  ['boosts', 'Server boosts'],
];

const VALID = new Set(STAT_TYPES.map(([t]) => t));
const NEEDS_MEMBERS = new Set(['humans', 'bots']);

// Discord rate-limits channel renames to ~2 per 10 minutes per channel, so a
// sustained refresh faster than every 5 minutes just builds a 429 backlog.
export const REFRESH_MIN_MINUTES = 5;
export const REFRESH_MAX_MINUTES = 60;
export const REFRESH_DEFAULT_MINUTES = 10;
const BASE_TICK_MS = 60 * 1000; // check which guilds are due once a minute

const clampInt = (v, min, max, dflt) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
};

export function normaliseServerStats(raw = {}) {
  return {
    refreshMinutes: clampInt(raw.refreshMinutes, REFRESH_MIN_MINUTES, REFRESH_MAX_MINUTES, REFRESH_DEFAULT_MINUTES),
    channels: (Array.isArray(raw.channels) ? raw.channels : [])
      .map((c) => ({
        channelId: /^\d{17,20}$/.test(c.channelId ?? '') ? c.channelId : '',
        type: VALID.has(c.type) ? c.type : 'members',
        template: String(c.template ?? '').slice(0, 80) || '{count}',
      }))
      .filter((c) => c.channelId && c.template.includes('{count}'))
      .slice(0, 10),
  };
}

function computeCount(guild, type, members) {
  switch (type) {
    case 'members':
      return guild.memberCount ?? 0;
    case 'roles':
      return Math.max(0, guild.roles.cache.size - 1); // exclude @everyone
    case 'channels':
      return guild.channels.cache.size;
    case 'boosts':
      return guild.premiumSubscriptionCount ?? 0;
    case 'humans':
      return members ? members.filter((m) => !m.user.bot).size : (guild.memberCount ?? 0);
    case 'bots':
      return members ? members.filter((m) => m.user.bot).size : 0;
    default:
      return 0;
  }
}

async function refreshGuild(guild, cfg) {
  let members = null;
  if (cfg.channels.some((c) => NEEDS_MEMBERS.has(c.type))) {
    members = await guild.members.fetch().catch(() => null);
  }

  for (const stat of cfg.channels) {
    const channel = guild.channels.cache.get(stat.channelId);
    if (!channel?.manageable) continue;
    const count = computeCount(guild, stat.type, members).toLocaleString('en');
    const desired = stat.template.replaceAll('{count}', count).slice(0, 100);
    if (channel.name !== desired) {
      await channel.setName(desired, 'Server stats refresh').catch(() => {});
    }
  }
}

const lastRefresh = new Map(); // guildId -> timestamp of the last rename pass

async function tick() {
  const client = runtime.client;
  if (!client?.isReady()) return;
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    const { enabled, config } = getGuildModule(guild.id, 'server-stats');
    if (!enabled) continue;
    const cfg = normaliseServerStats(config);
    if (cfg.channels.length === 0) continue;

    // Respect this guild's chosen interval.
    if (now - (lastRefresh.get(guild.id) ?? 0) < cfg.refreshMinutes * 60_000) continue;
    lastRefresh.set(guild.id, now);

    await refreshGuild(guild, cfg).catch((err) =>
      console.error(`[server-stats] refresh failed for ${guild.id}:`, err.message)
    );
  }
}

setInterval(() => {
  tick().catch((err) => console.error('[server-stats] tick failed:', err.message));
}, BASE_TICK_MS).unref();

// First pass a minute after boot.
setTimeout(() => tick().catch(() => {}), 60_000).unref();
