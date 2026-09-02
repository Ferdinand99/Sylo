// GET /metrics — Prometheus text exposition. Same trust level as the /health
// JSON (no auth, LAN/localhost or a scraper behind your own proxy); rate-limited
// in server.js so a misconfigured scrape interval can't spin the CPU.
//
// Gauges are computed here from live runtime state on every scrape. Counters come
// from the in-process registry in ../../lib/metrics.js.
import { Router } from 'express';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import { renderCounters } from '../../lib/metrics.js';
import { moduleUsage } from '../../db/dashboardStats.js';
import { dbFileInfo } from '../../db/backup.js';
import { MODULES } from '../../modules/registry.js';

const router = Router();

function gauge(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
}

router.get('/', (req, res) => {
  const ping = runtime.client?.ws?.ping;
  const blocks = [
    gauge('sylo_up', '1 when the Discord gateway is connected, else 0', isDiscordReady() ? 1 : 0),
    gauge('sylo_uptime_seconds', 'Seconds since the process started', uptimeSeconds()),
    gauge('sylo_guilds', 'Guilds the bot is currently in', guildCount()),
    gauge(
      'sylo_gateway_ping_ms',
      'Discord gateway heartbeat latency in ms (-1 when unknown)',
      typeof ping === 'number' && ping >= 0 ? Math.round(ping) : -1
    ),
    gauge('sylo_db_bytes', 'Size of the SQLite database file in bytes', dbFileInfo().size),
    gauge('sylo_errors_recorded', 'Errors currently held in the /health ring buffer', runtime.errors.length),
  ];

  const usage = moduleUsage();
  const moduleLines = [
    '# HELP sylo_module_enabled Number of guilds with a module enabled',
    '# TYPE sylo_module_enabled gauge',
    ...MODULES.map((m) => `sylo_module_enabled{module="${m.id}"} ${usage.get(m.id) ?? 0}`),
  ];

  const counters = renderCounters();
  const body = `${blocks.join('\n')}\n${moduleLines.join('\n')}\n` + (counters ? `\n${counters}` : '');

  res.type('text/plain; version=0.0.4; charset=utf-8').send(body);
});

export default router;
