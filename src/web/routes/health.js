// GET /health
//  - non-browser request  -> machine-readable JSON for the Docker healthcheck /
//    uptime monitors (200 when the Discord client is connected, 503 otherwise).
//  - browser request       -> the human status page (bot state, module adoption,
//    database + backups, recent stat lookups). Gated by auth when auth is enabled.
import { Router, raw } from 'express';
import { createRequire } from 'node:module';
import { config } from '../../config.js';
import { runtime, uptimeSeconds, isDiscordReady, guildCount } from '../../runtime.js';
import { recentLookups } from '../../db/cache.js';
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
import { MODULES } from '../../modules/registry.js';
import { timeAgo, formatUptime, formatBytes } from '../lib/format.js';

const require = createRequire(import.meta.url);
const { version } = require('../../../package.json');

const router = Router();

/** Require a signed-in user for the admin actions (pass-through in open mode). */
function requireUser(req, res, next) {
  if (!config.authEnabled || req.session?.user) return next();
  if ((req.headers.accept || '').includes('text/html')) {
    if (req.session) req.session.returnTo = '/health';
    return res.redirect('/auth/discord/login');
  }
  return res.status(403).json({ error: 'authentication required' });
}

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

  const dbInfo = dbFileInfo();

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
    db: {
      size: formatBytes(dbInfo.size),
      wal: formatBytes(dbInfo.wal),
      intervalHours: config.backupIntervalHours,
      retention: config.backupRetention,
    },
    backups: listBackups().slice(0, 25).map((b) => ({
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
router.post('/backups', requireUser, (req, res) => {
  try {
    const { name } = runBackup('manual');
    res.redirect(`/health?backup=${encodeURIComponent(name)}`);
  } catch (err) {
    res.redirect(`/health?backuperr=${encodeURIComponent(err.message || 'backup failed')}`);
  }
});

// Download a snapshot.
router.get('/backups/:name', requireUser, (req, res) => {
  const stream = openBackup(req.params.name);
  if (!stream) return res.status(404).json({ error: 'no such backup' });
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
  res.type('application/octet-stream');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// Delete a snapshot.
router.post('/backups/:name/delete', requireUser, (req, res) => {
  deleteBackup(req.params.name);
  res.redirect('/health');
});

// Import (upload) a .db file — stored as a snapshot the operator can then restore.
// The browser posts the raw file as the request body (see the Health page script).
router.post('/backups/import', requireUser, raw({ type: () => true, limit: '512mb' }), (req, res) => {
  const result = importBuffer(req.body);
  if (!result.ok) return res.redirect(`/health?importerr=${encodeURIComponent(result.error)}`);
  res.redirect(`/health?imported=${encodeURIComponent(result.name)}`);
});

// Restore the database from a snapshot, then exit so the process manager restarts
// Sylo on the restored data. A "prerestore" snapshot is taken first.
router.post('/backups/:name/restore', requireUser, (req, res) => {
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
