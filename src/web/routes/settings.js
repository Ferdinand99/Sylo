// Bot-wide settings (not per guild). Currently: the Discord presence / activity.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { getPresenceConfig, setPresenceConfig, PRESENCE_TYPES, PRESENCE_STATUSES } from '../../db/appSettings.js';
import { applyPresence } from '../../bot/lib/presence.js';

const router = Router();

router.get('/', (req, res) => {
  res.render('settings', {
    presence: getPresenceConfig(),
    presenceTypes: PRESENCE_TYPES,
    presenceStatuses: PRESENCE_STATUSES,
    botTag: runtime.client?.user?.tag ?? null,
    saved: req.query.saved === '1',
  });
});

router.post('/presence', (req, res) => {
  setPresenceConfig({
    status: req.body.status,
    type: req.body.type,
    text: req.body.text,
  });
  if (runtime.client) applyPresence(runtime.client);
  res.redirect('/settings?saved=1');
});

export default router;
