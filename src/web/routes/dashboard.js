// GET / — the human-facing dashboard: bot online state, activity across every
// server, module adoption, and the most recently queried stats.
import { Router } from 'express';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import { recentLookups } from '../../db/cache.js';
import { dashboardStats, moduleUsage } from '../../db/dashboardStats.js';
import { MODULES } from '../../modules/registry.js';
import { timeAgo, formatUptime } from '../lib/format.js';

const router = Router();

router.get('/', (req, res) => {
  const client = runtime.client;
  const guilds = client ? [...client.guilds.cache.values()] : [];
  const memberReach = guilds.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
  const gatewayPing = client?.ws?.ping;

  const recent = recentLookups(10).map((r) => ({ ...r, ago: timeAgo(r.created_at) }));

  const usage = moduleUsage();
  const modules = MODULES.map((m) => ({ name: m.name, icon: m.icon, guilds: usage.get(m.id) ?? 0 }))
    .filter((m) => m.guilds > 0)
    .sort((a, b) => b.guilds - a.guilds);

  res.render('dashboard', {
    ready: isDiscordReady(),
    botTag: client?.user?.tag ?? null,
    uptime: formatUptime(uptimeSeconds()),
    guildCount: guildCount(),
    memberReach,
    gatewayPing: typeof gatewayPing === 'number' && gatewayPing >= 0 ? Math.round(gatewayPing) : null,
    stats: dashboardStats(),
    modules,
    recent,
    lastError: runtime.lastError,
    lastErrorAgo: runtime.lastError ? timeAgo(runtime.lastError.at) : null,
  });
});

export default router;
