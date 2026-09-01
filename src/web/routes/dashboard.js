// GET / — entry point. Sends you straight to the plugin dashboard for the
// active server (URL guild, else last visited, else first manageable); falls
// back to a server picker when there is none.
import { Router } from 'express';
import { config } from '../../config.js';

const router = Router();

router.get('/', (req, res) => {
  if (res.locals.activeGuildId) {
    return res.redirect(`/guilds/${res.locals.activeGuildId}/overview`);
  }
  res.render('dashboard', { servers: res.locals.manageableGuilds || [] });
});

// Dev-only sanity check for the htmx foundation (Phase 0 of the dashboard
// modernization). Proves: a fragment swap, the CSRF token reaching the server on
// an htmx request, and an HX-Trigger toast. Remove once real conversions land.
if (config.nodeEnv !== 'production') {
  router.get('/__htmx-check', (req, res) => {
    res.render('htmx-check', { count: 0, csrfSeen: null });
  });
  router.post('/__htmx-check', (req, res) => {
    const count = (Number.parseInt(req.body.count, 10) || 0) + 1;
    res
      .set('HX-Trigger', JSON.stringify({ toast: { msg: `Bumped to ${count}`, kind: 'ok' } }))
      .render('partials/htmx-check-body', {
        count,
        csrfSeen: req.get('x-csrf-token') ? 'yes' : 'no',
      });
  });
}

export default router;
