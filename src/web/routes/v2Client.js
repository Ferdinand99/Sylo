// Serves the built V2 dashboard SPA (web-v2/, built via `npm run build:v2`
// into web-v2/dist/). Mounted at /v2, after the app-wide requireAuth in
// server.js, so this never serves to a logged-out visitor. Static assets
// first, then an index.html fallback for client-side routes (standard SPA
// hosting — the SPA's own router decides what /v2/guilds/123 etc. render).
//
// The exception is `v2PublicClientRouter`, mounted before requireAuth: the built files
// (the bundle holds no data) and the SPA shell for the two public pages, /v2/commands and
// /v2/roadmap. Everything else under /v2 still needs a login.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, static as expressStatic } from 'express';
import { config } from '../../config.js';
import { endClassicChoice } from '../lib/classicChoice.js';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', '..', '..', 'web-v2', 'dist');
const indexHtml = join(distDir, 'index.html');

/** Whether the SPA is built. An object so tests can stub `exists` and `indexHtml`; V1's home
 * (dashboard.js) sends people here only when it is. */
export const v2Build = { exists: () => existsSync(indexHtml), indexHtml };

/** The pages a visitor may open without signing in (paths below /v2). Keep in step with
 * PUBLIC_PATHS in web-v2/src/publicRoutes.js. */
export const PUBLIC_PAGES = ['/commands', '/roadmap'];

// Opening the dashboard (a page, not one of its files) ends a "Back to classic dashboard" choice
// made earlier in the session, so the next visit to / and to the old addresses goes to V2 again.
function endClassicChoiceOnPage(req, res) {
  if (req.method === 'GET' && !/\.\w+$/.test(req.path)) endClassicChoice(req, res);
}

function sendIndex(res) {
  if (!v2Build.exists()) {
    return res
      .status(503)
      .type('text/plain')
      .send('V2 dashboard not built yet — run `npm run build:v2` first.');
  }
  res.sendFile(v2Build.indexHtml);
}

// --- before requireAuth -------------------------------------------------------------------

export const v2PublicClientRouter = Router();

// The built files. Not index.html itself: that is served only for the pages above (and, behind the
// login, for the rest).
const builtFiles = expressStatic(distDir, { index: false, redirect: false });
v2PublicClientRouter.use((req, res, next) =>
  req.path === '/index.html' ? next() : builtFiles(req, res, next)
);

v2PublicClientRouter.get(PUBLIC_PAGES, (req, res) => {
  endClassicChoiceOnPage(req, res);
  // Signed out and logging in from the page: come back to it afterwards.
  if (config.authEnabled && !req.account && req.session) {
    req.session.returnTo = `/v2${req.path.toLowerCase().replace(/\/+$/, '')}`;
  }
  sendIndex(res);
});

// --- behind requireAuth -------------------------------------------------------------------

const router = Router();

router.use((req, res, next) => {
  endClassicChoiceOnPage(req, res);
  next();
});

router.use(expressStatic(distDir));

// A path-less `router.use` (rather than `router.get('*', ...)`) so this
// never touches path-to-regexp's wildcard syntax at all — Express 5 bumped
// path-to-regexp to a version that rejects a bare "*" (it now requires a
// named wildcard like "*splat"), which broke this the first time around.
router.use((req, res) => {
  if (req.method !== 'GET') return res.status(404).end();
  sendIndex(res);
});

export default router;
