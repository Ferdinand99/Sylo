// Sylo entrypoint — boots the database, the Discord bot, and the web dashboard
// in a single process.
import { config } from './config.js';
import { setLastError } from './runtime.js';
// Importing db/index.js opens the SQLite connection and runs migrations.
import { closeDb } from './db/index.js';
import { startBackupSchedule } from './db/backup.js';
import { startBot } from './bot/index.js';
import { startWeb } from './web/server.js';

// A rejected promise leaves the process in a recoverable state — log it and
// keep serving.
process.on('unhandledRejection', (reason) => {
  setLastError(reason);
  console.error('[sylo] Unhandled promise rejection:', reason);
});

// An uncaught exception may have left the process in an undefined state. Per
// Node's guidance, do not resume: record it, flush the DB, and exit so the
// container manager (restart: unless-stopped) brings us back up clean.
process.on('uncaughtException', (err) => {
  setLastError(err);
  console.error('[sylo] Uncaught exception - exiting for a clean restart:', err);
  closeDb();
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[sylo] ${signal} received - shutting down`);
    closeDb();
    process.exit(0);
  });
}

async function main() {
  console.log(`[sylo] Starting in ${config.nodeEnv} mode`);
  await startBot();
  await startWeb(config.webPort);
  startBackupSchedule();
  console.log('[sylo] Up and running');
}

main().catch((err) => {
  console.error('[sylo] Fatal error during startup:', err);
  closeDb();
  process.exit(1);
});
