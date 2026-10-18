// GET / — entry point. Sends you straight to the plugin dashboard for the
// active server (URL guild, else last visited, else first manageable); falls
// back to a server picker when there is none.
//
// People who turned on "Open the new dashboard by default" (V2's Account page,
// src/db/userPrefs.js) are sent to /v2 instead — see wantsV2Home for when.
import { Router } from 'express';
import { config } from '../../config.js';
import { sessionUserId } from '../middleware/auth.js';
import { getDashboardVersion } from '../../db/userPrefs.js';
import { v2Build } from './v2Client.js';

const router = Router();

// Only a signed-in person's own browser visit to the home page goes to V2: never an htmx
// fragment or a JSON caller, never open mode (no session there to remember "Back to classic
// dashboard", so every visit to / would bounce straight back), never after they chose the
// classic dashboard for this session, and never when the V2 build is missing (/v2 would only
// answer a plain-text "not built" page).
async function wantsV2Home(req) {
  if (!config.authEnabled || !req.session || req.session.preferClassic) return false;
  if (req.get('HX-Request') || req.accepts(['html', 'json']) !== 'html') return false;
  const userId = sessionUserId(req);
  if (!userId || !v2Build.exists()) return false;
  return (await getDashboardVersion(userId)) === 'v2';
}

router.get('/', async (req, res) => {
  // "Back to classic dashboard" (V2's top bar) lands here: stay on V1 for the rest of the
  // session. Opening /v2 again clears it (v2Client.js).
  if (req.query.classic === '1') {
    if (req.session) req.session.preferClassic = true;
  } else if (await wantsV2Home(req)) {
    return res.redirect('/v2');
  }
  if (res.locals.activeGuildId) {
    return res.redirect(`/guilds/${res.locals.activeGuildId}/overview`);
  }
  res.render('dashboard', { servers: res.locals.manageableGuilds || [] });
});

export default router;
