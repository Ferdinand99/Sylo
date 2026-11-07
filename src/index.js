// Sylo entrypoint — boots the database, the chat bot(s) (Discord and/or Fluxer),
// and the web dashboard in a single process.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { dataFolderWarning } from './lib/sessionSecret.js';
import { log } from './lib/log.js';
import { runtime } from './runtime.js';
// Importing db/index.js opens the SQLite connection and runs migrations.
import { closeDb } from './db/index.js';
import { startBackupSchedule } from './db/backup.js';
import { startRetentionSchedule } from './db/retention.js';
import { startBot } from './bot/index.js';
import { startFluxerBot } from './bot/fluxerBot.js';
import { startSchedules, stopSchedules } from './modules/schedule.js';
import { startWeb } from './web/server.js';
import { addDevLogSink } from './lib/devLog.js';
import { addDevLogEntry } from './db/devLogEntries.js';
import { notifyDevLogEvent, warmUpPigeon } from './lib/push.js';
import { flushErrorReports, startErrorReports } from './lib/errorReports.js';
import { logUnhandledRejection } from './lib/discordErrors.js';

/** Postgres install with the session secret in a data folder that is not a mounted volume (Linux only). */
function warnIfDataFolderIsNotAVolume() {
  let mountinfo = null;
  if (process.platform === 'linux') {
    try {
      mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      // cannot tell: stay quiet
    }
  }
  const warning = dataFolderWarning({
    source: config.sessionSecretSource,
    databaseUrl: config.databaseUrl,
    dataDir: dirname(resolve(process.cwd(), config.databasePath)),
    mountinfo,
  });
  if (warning) log.warn('sylo', warning);
}

/** Set once the HTTP server is listening; used by the shutdown path. */
let httpServer = null;

// A rejected promise leaves the process in a recoverable state — log it and
// keep serving. (log.error also records it in the /health error history.)
process.on('unhandledRejection', logUnhandledRejection);

// An uncaught exception may have left the process in an undefined state. Per
// Node's guidance, do not resume: record it, flush the DB, and exit so the
// container manager (restart: unless-stopped) brings us back up clean.
process.on('uncaughtException', (err) => {
  log.error('sylo', 'Uncaught exception — exiting for a clean restart', err);
  closeDb();
  // Give its error report (if BOT_ERROR_DSN is set) up to 2 s to leave first.
  flushErrorReports(2000).finally(() => process.exit(1));
});

let shuttingDown = false;

// Stop accepting new HTTP connections, close the gateway session, flush the DB,
// then exit — but never hang: a stuck connection can't hold shutdown past ~3s.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('sylo', `${signal} received — shutting down`);

  // Module timers first: no new tick starts, and a running one gets up to 3 s to finish before
  // the HTTP server and the clients close under it.
  await stopSchedules();

  const drained = Promise.allSettled([
    httpServer ? new Promise((resolve) => httpServer.close(resolve)) : Promise.resolve(),
    ...Object.values(runtime.clients).map((client) => client?.destroy?.() ?? Promise.resolve()),
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
  // First, so a failing start is reported too (a no-op unless BOT_ERROR_DSN is set).
  await startErrorReports();
  // Sylo's own errors and warnings: stored for the app's Health page, and pushed to operators'
  // devices at the level each chose (src/lib/devLog.js). Neither sink logs through log.js.
  addDevLogSink((event) => addDevLogEntry(event));
  addDevLogSink((event) => notifyDevLogEvent(event));
  log.info('sylo', `Starting in ${config.nodeEnv} mode`);
  if (config.sessionSecretSource === 'generated-ephemeral') {
    log.warn(
      'sylo',
      'Session secret could not be saved, so it is lost at restart: logins and verify/appeal links stop working then. Set SESSION_SECRET or make the data folder writable.'
    );
  } else {
    log.info(
      'sylo',
      `Session secret from ${config.sessionSecretSource === 'env' ? 'SESSION_SECRET' : 'the data folder'}`
    );
  }
  warnIfDataFolderIsNotAVolume();
  // Every configured platform starts in parallel; one that is not configured is never loaded.
  await Promise.all([config.discordEnabled && startBot(), config.fluxerEnabled && startFluxerBot()]);
  httpServer = await startWeb(config.webPort);
  startSchedules();
  startBackupSchedule();
  startRetentionSchedule();
  // Register with Postal Pigeon now (if PIGEON_URL is set and this instance has not yet), so the
  // log shows whether it works. In the background: it never holds up the start.
  void warmUpPigeon();
  log.info('sylo', 'Up and running');
}

main().catch((err) => {
  log.error('sylo', 'Fatal error during startup', err);
  closeDb();
  process.exit(1);
});
