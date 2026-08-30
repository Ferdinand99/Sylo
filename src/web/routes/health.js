// GET /health
//  - non-browser request  -> machine-readable JSON for the Docker healthcheck /
//    uptime monitors (200 when the Discord client is connected, 503 otherwise).
//  - browser request       -> the human status page (bot state, module adoption,
//    recent stat lookups). Gated by auth when auth is enabled.
import { Router } from 'express';
import { createRequire } from 'node:module';
import { config } from '../../config.js';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import { recentLookups } from '../../db/cache.js';
import { dashboardStats, moduleUsage } from '../../db/dashboardStats.js';
import { MODULES } from '../../modules/registry.js';
import { timeAgo, formatUptime } from '../lib/format.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const router = Router();

router.get('/', (req, res) => {
  const ready = isDiscordReady();
  const wantsHtml = (req.headers.accept || '').includes('text/html');

  if (!wantsHtml) {
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      version,
      uptimeSeconds: uptimeSeconds(),
      discord: { ready, guilds: guildCount() },
      lastError: runtime.lastError,
    });
  }

  if (config.authEnabled && !req.session?.user) {
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }

  const client = runtime.client;
  const guilds = client ? [...client.guilds.cache.values()] : [];
  const memberReach = guilds.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
  const gatewayPing = client?.ws?.ping;

  const usage = moduleUsage();
  const modules = MODULES.map((m) => ({ name: m.name, icon: m.icon, guilds: usage.get(m.id) ?? 0 }))
    .filter((m) => m.guilds > 0)
    .sort((a, b) => b.guilds - a.guilds);

  res.render('health', {
    ready,
    botTag: client?.user?.tag ?? null,
    uptime: formatUptime(uptimeSeconds()),
    guildCount: guildCount(),
    memberReach,
    gatewayPing: typeof gatewayPing === 'number' && gatewayPing >= 0 ? Math.round(gatewayPing) : null,
    stats: dashboardStats(),
    modules,
    recent: recentLookups(10).map((r) => ({ ...r, ago: timeAgo(r.created_at) })),
    lastError: runtime.lastError,
    lastErrorAgo: runtime.lastError ? timeAgo(runtime.lastError.at) : null,
  });
});

export default router;
