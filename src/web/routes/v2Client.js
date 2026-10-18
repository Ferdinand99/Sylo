// Serves the built V2 dashboard SPA (web-v2/, built via `npm run build:v2`
// into web-v2/dist/). Mounted at /v2, after the app-wide requireAuth in
// server.js, so this never serves to a logged-out visitor. Static assets
// first, then an index.html fallback for client-side routes (standard SPA
// hosting — the SPA's own router decides what /v2/guilds/123 etc. render).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, static as expressStatic } from 'express';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', '..', '..', 'web-v2', 'dist');
const indexHtml = join(distDir, 'index.html');

/** Whether the SPA is built. An object so tests can stub `exists`; V1's home (dashboard.js)
 * only sends people here by default when it is. */
export const v2Build = { exists: () => existsSync(indexHtml) };

const router = Router();

// Opening the dashboard (a page, not one of its files) ends a "Back to classic dashboard"
// choice made earlier in the session, so the next visit to / follows the saved preference again.
router.use((req, res, next) => {
  if (req.method === 'GET' && req.session?.preferClassic && !/\.\w+$/.test(req.path)) {
    delete req.session.preferClassic;
  }
  next();
});

router.use(expressStatic(distDir));

// A path-less `router.use` (rather than `router.get('*', ...)`) so this
// never touches path-to-regexp's wildcard syntax at all — Express 5 bumped
// path-to-regexp to a version that rejects a bare "*" (it now requires a
// named wildcard like "*splat"), which broke this the first time around.
router.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).end();
  if (!v2Build.exists()) {
    return res
      .status(503)
      .type('text/plain')
      .send('V2 dashboard not built yet — run `npm run build:v2` first.');
  }
  res.sendFile(indexHtml);
});

export default router;
