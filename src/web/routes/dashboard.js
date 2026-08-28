// GET / — the human-facing dashboard: bot online state, guild list, and the
// most recently queried stats (from the cache table).
import { Router } from 'express';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import { recentLookups } from '../../db/cache.js';
import { timeAgo, formatUptime } from '../lib/format.js';

const router = Router();

router.get('/', (req, res) => {
  const client = runtime.client;
  const guilds = client
    ? [...client.guilds.cache.values()]
        .map((g) => ({ id: g.id, name: g.name, memberCount: g.memberCount ?? 0 }))
        .sort((a, b) => b.memberCount - a.memberCount)
    : [];

  const recent = recentLookups(10).map((r) => ({
    ...r,
    ago: timeAgo(r.created_at),
  }));

  res.render('dashboard', {
    ready: isDiscordReady(),
    botTag: client?.user?.tag ?? null,
    uptime: formatUptime(uptimeSeconds()),
    guildCount: guildCount(),
    guilds,
    recent,
    lastError: runtime.lastError,
    lastErrorAgo: runtime.lastError ? timeAgo(runtime.lastError.at) : null,
  });
});

export default router;
