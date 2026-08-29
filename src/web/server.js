// Express app for the Sylo web dashboard.
// Runs in the same process as the bot and reads live bot state from ../runtime.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { setLastError } from '../runtime.js';
import { mountAuth, requireAuth } from './middleware/auth.js';
import healthRouter from './routes/health.js';
import dashboardRouter from './routes/dashboard.js';
import statsRouter from './routes/stats.js';
import commandsRouter from './routes/commands.js';
import guildsRouter from './routes/guilds.js';
import guildTicketsRouter from './routes/guildTickets.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Build (but do not start) the Express app. Exposed for testing. */
export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', join(here, 'views'));
  app.use(express.static(join(here, 'public')));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Session + res.locals + /auth/* routes. No-op guards in open mode.
  mountAuth(app);

  // Public: healthcheck only.
  app.use('/health', healthRouter);

  // Everything below requires a signed-in user when auth is enabled.
  app.use(requireAuth);
  app.use('/', dashboardRouter);
  app.use('/stats', statsRouter);
  app.use('/commands', commandsRouter);
  // Tickets are mounted first: they have their own (staff-role aware) access
  // check, so they must not fall through to the admin-only /guilds router.
  app.use('/guilds/:guildId/tickets', guildTicketsRouter);
  app.use('/guilds', guildsRouter);

  // Central error handler — keep the server up, record the error for the dashboard.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    setLastError(err);
    console.error('[web] Request error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

/**
 * Start the dashboard HTTP server.
 * @param {number} port
 * @returns {Promise<import('node:http').Server>}
 */
export function startWeb(port) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`[web] Dashboard listening on http://localhost:${port}`);
      resolve(server);
    });
  });
}
