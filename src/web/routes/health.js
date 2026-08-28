// GET /health — machine-readable bot status for Docker healthchecks and uptime
// monitors. Returns 200 when the Discord client is connected, 503 otherwise.
import { Router } from 'express';
import { createRequire } from 'node:module';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const router = Router();

router.get('/', (req, res) => {
  const ready = isDiscordReady();
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'degraded',
    version,
    uptimeSeconds: uptimeSeconds(),
    discord: {
      ready,
      guilds: guildCount(),
    },
    lastError: runtime.lastError,
  });
});

export default router;
