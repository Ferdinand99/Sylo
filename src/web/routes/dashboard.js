// GET / — entry point. Everyone is sent to the new dashboard (/v2), in open mode too, as long as
// it is built. The one way to stay on the classic dashboard (for this release) is "Back to classic
// dashboard" (/?classic=1), which lasts for the rest of the browser session; the stored
// `dashboard_version` preference no longer opts out. The classic home sends you to the plugin
// dashboard for the active server (URL guild, else last visited, else first manageable) and falls
// back to a server picker when there is none.
import { Router } from 'express';
import { chooseClassic, isBrowserPageVisit, prefersClassic } from '../lib/classicChoice.js';
import { v2Build } from './v2Client.js';

const router = Router();

// Only a person's own browser visit to the home page goes to V2: never an htmx fragment or a JSON
// caller, never after they chose the classic dashboard, and never when the V2 build is missing (/v2
// would only answer a plain-text "not built" page).
const wantsV2Home = (req) => isBrowserPageVisit(req) && !prefersClassic(req) && v2Build.exists();

router.get('/', (req, res) => {
  // "Back to classic dashboard" (V2's top bar) lands here: stay on the classic dashboard for the
  // rest of the session. Opening /v2 again clears it (v2Client.js).
  if (req.query.classic === '1') {
    chooseClassic(req, res);
  } else if (wantsV2Home(req)) {
    return res.redirect('/v2');
  }
  if (res.locals.activeGuildId) {
    return res.redirect(`/guilds/${res.locals.activeGuildId}/overview`);
  }
  res.render('dashboard', { servers: res.locals.manageableGuilds || [] });
});

export default router;
