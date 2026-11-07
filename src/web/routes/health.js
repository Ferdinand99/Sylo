// GET /health: machine-readable JSON for monitors (the Docker healthcheck, uptime checks), 200
// when a platform client is connected, 503 otherwise. Public. The human status page and the
// backup tools live in the dashboard (/v2/health, /api/v2/health/*); a browser visit to
// /health is sent there by middleware/classicRedirect.js before it gets here.
import { primaryClient } from '../../platform/platformOf.js';
import { Router } from 'express';
import { createRequire } from 'node:module';
import { isOwner } from '../middleware/auth.js';
import {
  runtime,
  uptimeSeconds,
  isAnyClientReady,
  totalGuildCount,
  platformStatus,
  errorScopeCounts,
  recentErrorCount,
} from '../../runtime.js';
import { byMetric } from '../../lib/metrics.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const router = Router();

router.get('/', (req, res) => {
  const ready = isAnyClientReady();
  const ping = primaryClient()?.ws?.ping;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    version,
    uptimeSeconds: uptimeSeconds(),
    platforms: platformStatus(),
    discord: {
      ready,
      guilds: totalGuildCount(),
      gatewayPingMs: typeof ping === 'number' && ping >= 0 ? Math.round(ping) : null,
      gatewayPingHistory: runtime.pingHistory.slice(),
    },
    // Error messages can carry a server admin's URL or an internal address: operators only.
    ...(isOwner(req) ? { lastError: runtime.lastError } : {}),
    errorCount: runtime.errors.length,
    // For uptime monitors: errors in the last hour (errorCount only resets on a restart).
    errorsLastHour: recentErrorCount(60 * 60_000),
    errorsByScope: errorScopeCounts(),
    commands: byMetric('sylo_commands_total')
      .map((c) => ({ name: c.labels.command ?? 'unknown', count: c.value }))
      .sort((a, b) => b.count - a.count),
  });
});

export default router;
