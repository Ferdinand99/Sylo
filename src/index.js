// Sylo entrypoint — boots the database, the Discord bot, and the web dashboard
// in a single process.
import { config } from './config.js';
import { log } from './lib/log.js';
import { runtime } from './runtime.js';
// Importing db/index.js opens the SQLite connection and runs migrations.
import { closeDb } from './db/index.js';
import { startBackupSchedule } from './db/backup.js';
import { startRetentionSchedule } from './db/retention.js';
import { startBot } from './bot/index.js';
import { startWeb } from './web/server.js';

/** Set once the HTTP server is listening; used by the shutdown path. */
let httpServer = null;

// A rejected promise leaves the process in a recoverable state — log it and
// keep serving. (log.error also records it in the /health error history.)
process.on('unhandledRejection', (reason) => {
  log.error('sylo', 'Unhandled promise rejection', reason);
});

// An uncaught exception may have left the process in an undefined state. Per
// Node's guidance, do not resume: record it, flush the DB, and exit so the
// container manager (restart: unless-stopped) brings us back up clean.
process.on('uncaughtException', (err) => {
  log.error('sylo', 'Uncaught exception — exiting for a clean restart', err);
  closeDb();
  process.exit(1);
});

let shuttingDown = false;

// Stop accepting new HTTP connections, close the gateway session, flush the DB,
// then exit — but never hang: a stuck connection can't hold shutdown past ~3s.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('sylo', `${signal} received — shutting down`);

  const drained = Promise.allSettled([
    httpServer ? new Promise((resolve) => httpServer.close(resolve)) : Promise.resolve(),
    runtime.client?.destroy?.() ?? Promise.resolve(),
  ]);
  await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 3000).unref())]);

  closeDb();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(0));
  });
}

async function main() {
  log.info('sylo', `Starting in ${config.nodeEnv} mode`);
  await startBot();
  httpServer = await startWeb(config.webPort);
  startBackupSchedule();
  startRetentionSchedule();
  log.info('sylo', 'Up and running');
}

main().catch((err) => {
  log.error('sylo', 'Fatal error during startup', err);
  closeDb();
  process.exit(1);
});
