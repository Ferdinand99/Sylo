// Bot Personalizer — bot-wide identity (username / avatar / banner) and
// presence. Identity changes hit the Discord API live; presence is stored and
// re-applied on every startup.
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getPresenceConfig,
  setPresenceConfig,
  PRESENCE_TYPES,
  PRESENCE_STATUSES,
} from '../../db/appSettings.js';
import { applyPresence } from '../../bot/lib/presence.js';

const router = Router();
const isHttps = (u) => /^https:\/\/\S+$/i.test(u);

function back(res, text, ok) {
  res.redirect(`/settings?m=${encodeURIComponent(text)}&ok=${ok ? 1 : 0}`);
}

router.get('/', (req, res) => {
  const u = runtime.client?.user ?? null;
  res.render('settings', {
    bot: u
      ? {
          tag: u.tag,
          username: u.username,
          id: u.id,
          avatar: u.displayAvatarURL({ size: 128 }),
          banner: u.bannerURL ? u.bannerURL({ size: 512 }) : null,
        }
      : null,
    presence: getPresenceConfig(),
    presenceTypes: PRESENCE_TYPES,
    presenceStatuses: PRESENCE_STATUSES,
    m: typeof req.query.m === 'string' ? req.query.m : null,
    ok: req.query.ok === '1',
  });
});

router.post(
  '/identity',
  asyncHandler(async (req, res) => {
    const u = runtime.client?.user;
    if (!u) return back(res, 'The bot is not connected yet — try again in a moment.', false);

    const done = [];
    const failed = [];

    const name = String(req.body.username || '').trim();
    if (name && name !== u.username) {
      if (name.length < 2 || name.length > 32) failed.push('username (2–32 characters)');
      else {
        try {
          await u.setUsername(name);
          done.push('username');
        } catch (e) {
          failed.push(`username (${e.message || 'rejected — Discord limits this to ~2 changes/hour'})`);
        }
      }
    }

    if (req.body.resetAvatar === 'on') {
      try {
        await u.setAvatar(null);
        done.push('avatar reset to default');
      } catch {
        failed.push('avatar reset');
      }
    } else {
      const avatar = String(req.body.avatarUrl || '').trim();
      if (avatar) {
        if (!isHttps(avatar)) failed.push('avatar (must be an https image URL)');
        else {
          try {
            await u.setAvatar(avatar);
            done.push('avatar');
          } catch (e) {
            failed.push(`avatar (${e.message || 'could not load that image'})`);
          }
        }
      }
    }

    const banner = String(req.body.bannerUrl || '').trim();
    if (banner) {
      if (!isHttps(banner)) failed.push('banner (must be an https image URL)');
      else {
        try {
          await u.setBanner(banner);
          done.push('banner');
        } catch (e) {
          failed.push(`banner (${e.message || 'not available for this bot'})`);
        }
      }
    }

    if (!done.length && !failed.length) return back(res, 'Nothing to change.', true);
    const parts = [];
    if (done.length) parts.push(`Updated ${done.join(', ')}.`);
    if (failed.length) parts.push(`Failed: ${failed.join('; ')}.`);
    back(res, parts.join(' '), failed.length === 0);
  })
);

router.post('/presence', (req, res) => {
  setPresenceConfig({ status: req.body.status, type: req.body.type, text: req.body.text });
  if (runtime.client) applyPresence(runtime.client);
  back(res, 'Presence updated.', true);
});

export default router;
