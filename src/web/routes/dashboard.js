// GET / — entry point. Sends you straight to the plugin dashboard for the
// active server (URL guild, else last visited, else first manageable); falls
// back to a server picker when there is none.
import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  if (res.locals.activeGuildId) {
    return res.redirect(`/guilds/${res.locals.activeGuildId}/overview`);
  }
  res.render('dashboard', { servers: res.locals.manageableGuilds || [] });
});

export default router;
