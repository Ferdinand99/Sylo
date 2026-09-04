// GET /health
//  - machine request (Docker healthcheck, uptime monitor: no `Accept: text/html`,
//    no htmx header) -> machine-readable JSON, 200 when the Discord client is
//    connected, 503 otherwise.
//  - browser request (a normal navigation *or* an hx-boost click from the
//    dashboard sidebar) -> the human status page. Gated by auth when enabled.
import { Router, raw } from 'express';
import { createRequire } from 'node:module';
import { config } from '../../config.js';
import { requireOwner, isOwner, forbidOwner } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { runtime, uptimeSeconds, isDiscordReady, guildCount, errorScopeCounts } from '../../runtime.js';
import { byMetric } from '../../lib/metrics.js';
import { dashboardStats, moduleUsage } from '../../db/dashboardStats.js';
import {
  listBackups,
  runBackup,
  openBackup,
  deleteBackup,
  dbFileInfo,
  importBuffer,
  restoreFromBackup,
  resolveBackup,
  inspectDbFile,
} from '../../db/backup.js';
import { offsiteBackupStatus } from '../../db/offsiteBackup.js';
import { MODULES } from '../../modules/registry.js';
import { timeAgo, formatUptime, formatBytes } from '../lib/format.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const router = Router();

// Backup create / import / restore / delete write files or swap the live DB.
// Cap the rate even behind auth — a stuck script shouldn't be able to fill the
// disk or thrash restarts. All /health routes share one bucket (keyed on the
// mount path); the GET healthcheck is not wrapped, so monitors are unaffected.
const backupLimit = rateLimit({
  windowMs: 60_000,
  max: 12,
  message: 'Too many backup operations — wait a minute.',
});

router.get('/', (req, res) => {
  const ready = isDiscordReady();
  // htmx (hx-boost) navigations fetch with `Accept: */*`, so fall back to the
  // HX-Request header — without this a boosted sidebar click renders the JSON.
  const wantsHtml = (req.headers.accept || '').includes('text/html') || Boolean(req.get('HX-Request'));

  if (!wantsHtml) {
    const ping = runtime.client?.ws?.ping;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      version,
      uptimeSeconds: uptimeSeconds(),
      discord: {
        ready,
        guilds: guildCount(),
        gatewayPingMs: typeof ping === 'number' && ping >= 0 ? Math.round(ping) : null,
        gatewayPingHistory: runtime.pingHistory.slice(),
      },
      lastError: runtime.lastError,
      errorCount: runtime.errors.length,
      errorsByScope: errorScopeCounts(),
      commands: byMetric('sylo_commands_total')
        .map((c) => ({ name: c.labels.command ?? 'unknown', count: c.value }))
        .sort((a, b) => b.count - a.count),
    });
  }

  if (config.authEnabled && !req.session?.user) {
    if (req.session) req.session.returnTo = req.originalUrl;
    return res.redirect('/auth/discord/login');
  }
  if (config.authEnabled && !isOwner(req.session.user.id)) {
    return forbidOwner(res);
  }

  const client = runtime.client;
  const guilds = client ? [...client.guilds.cache.values()] : [];
  const memberReach = guilds.reduce((sum, g) => sum + (g.memberCount ?? 0), 0);
  const gatewayPing = client?.ws?.ping;

  const usage = moduleUsage();
  const modules = MODULES.map((m) => ({ name: m.name, icon: m.icon, guilds: usage.get(m.id) ?? 0 }))
    .filter((m) => m.guilds > 0)
    .sort((a, b) => b.guilds - a.guilds);

  const dbInfo = dbFileInfo();

  res.render('health', {
    ready,
    botTag: client?.user?.tag ?? null,
    uptime: formatUptime(uptimeSeconds()),
    guildCount: guildCount(),
    memberReach,
    gatewayPing: typeof gatewayPing === 'number' && gatewayPing >= 0 ? Math.round(gatewayPing) : null,
    pingHistory: runtime.pingHistory.slice(),
    stats: dashboardStats(),
    modules,
    lastError: runtime.lastError,
    lastErrorAgo: runtime.lastError ? timeAgo(runtime.lastError.at) : null,
    errors: runtime.errors.slice(0, 25).map((e) => ({
      message: e.message,
      scope: e.scope,
      ago: timeAgo(e.at),
    })),
    db: {
      size: formatBytes(dbInfo.size),
      wal: formatBytes(dbInfo.wal),
      intervalHours: config.backupIntervalHours,
      retention: config.backupRetention,
      offsite: offsiteBackupStatus(),
    },
    backups: listBackups()
      .slice(0, 25)
      .map((b) => ({
        name: b.name,
        size: formatBytes(b.size),
        ago: timeAgo(b.mtime),
      })),
    backupMsg: typeof req.query.backup === 'string' ? req.query.backup : null,
    backupErr: typeof req.query.backuperr === 'string' ? req.query.backuperr : null,
    importMsg: typeof req.query.imported === 'string' ? req.query.imported : null,
    importErr: typeof req.query.importerr === 'string' ? req.query.importerr : null,
    restoreErr: typeof req.query.restoreerr === 'string' ? req.query.restoreerr : null,
  });
});

// Create a snapshot now.
router.post('/backups', requireOwner, backupLimit, (req, res) => {
  try {
    const { name } = runBackup('manual');
    res.redirect(`/health?backup=${encodeURIComponent(name)}`);
  } catch (err) {
    res.redirect(`/health?backuperr=${encodeURIComponent(err.message || 'backup failed')}`);
  }
});

// Download a snapshot.
router.get('/backups/:name', requireOwner, (req, res) => {
  const stream = openBackup(req.params.name);
  if (!stream) return res.status(404).json({ error: 'no such backup' });
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.type('application/octet-stream');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// Delete a snapshot.
router.post('/backups/:name/delete', requireOwner, backupLimit, (req, res) => {
  deleteBackup(req.params.name);
  res.redirect('/health');
});

// Import (upload) a .db file — stored as a snapshot the operator can then restore.
// The browser posts the raw file as the request body (see the Health page script).
router.post(
  '/backups/import',
  requireOwner,
  backupLimit,
  raw({ type: () => true, limit: '128mb' }),
  (req, res) => {
    const result = importBuffer(req.body);
    if (!result.ok) return res.redirect(`/health?importerr=${encodeURIComponent(result.error)}`);
    res.redirect(`/health?imported=${encodeURIComponent(result.name)}`);
  }
);

// Restore the database from a snapshot, then exit so the process manager restarts
// Sylo on the restored data. A "prerestore" snapshot is taken first.
router.post('/backups/:name/restore', requireOwner, backupLimit, (req, res) => {
  const name = req.params.name;
  const full = resolveBackup(name);
  if (!full) return res.redirect('/health?restoreerr=no%20such%20backup');
  const check = inspectDbFile(full);
  if (!check.ok) return res.redirect(`/health?restoreerr=${encodeURIComponent(check.error)}`);

  res.render('restoring', { title: 'Sylo — Restoring', name });
  // Let the response flush before restoreFromBackup() closes the DB and exits.
  setTimeout(() => restoreFromBackup(name), 750);
});

export default router;
