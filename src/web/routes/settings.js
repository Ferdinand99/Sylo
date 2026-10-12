// Bot Personalizer — bot-wide identity (username / avatar / banner) and
// presence. Identity changes hit the Discord API live; presence is stored and
// re-applied on every startup.
import { primaryClient } from '../../platform/platformOf.js';
import { Router } from 'express';
import { runtime } from '../../runtime.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { currentUser } from '../middleware/auth.js';
import {
  getPresenceConfig,
  setPresenceConfig,
  PRESENCE_TYPES,
  PRESENCE_STATUSES,
  getAnnouncement,
  setAnnouncement,
  clearAnnouncement,
  ANNOUNCEMENT_SEVERITIES,
} from '../../db/appSettings.js';
import { applyPresence } from '../../bot/lib/presence.js';
import { recordBotAudit } from '../../db/botAudit.js';

const router = Router();
const isHttps = (u) => /^https:\/\/\S+$/i.test(u);
// Mirrors v2Api.js's private moderatorDisplayName() — used for bot-wide
// audit-log "actor" strings, same convention guild audit logs use.
const actorFor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);

function back(res, text, ok) {
  res.redirect(`/settings?m=${encodeURIComponent(text)}&ok=${ok ? 1 : 0}`);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const u = primaryClient()?.user ?? null;
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
      presence: await getPresenceConfig(),
      presenceTypes: PRESENCE_TYPES,
      presenceStatuses: PRESENCE_STATUSES,
      announcement: await getAnnouncement(),
      announcementSeverities: ANNOUNCEMENT_SEVERITIES,
      m: typeof req.query.m === 'string' ? req.query.m : null,
      ok: req.query.ok === '1',
    });
  })
);

router.post(
  '/identity',
  asyncHandler(async (req, res) => {
    const u = primaryClient()?.user;
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
    if (done.length) {
      await recordBotAudit({
        actor: actorFor(req),
        action: 'personalizer:identity',
        detail: done.join(', '),
      });
    }
    const parts = [];
    if (done.length) parts.push(`Updated ${done.join(', ')}.`);
    if (failed.length) parts.push(`Failed: ${failed.join('; ')}.`);
    back(res, parts.join(' '), failed.length === 0);
  })
);

router.post(
  '/presence',
  asyncHandler(async (req, res) => {
    const presence = await setPresenceConfig({
      status: req.body.status,
      type: req.body.type,
      text: req.body.text,
    });
    if (runtime.client) applyPresence(runtime.client);
    await recordBotAudit({
      actor: actorFor(req),
      action: 'personalizer:presence',
      detail: `${presence.status} / ${presence.type} / ${presence.text}`,
    });
    back(res, 'Presence updated.', true);
  })
);

router.post(
  '/announcement',
  asyncHandler(async (req, res) => {
    const saved = await setAnnouncement({
      title: req.body.title,
      body: req.body.body,
      severity: req.body.severity,
    });
    await recordBotAudit({
      actor: actorFor(req),
      action: 'personalizer:announcement',
      detail: saved ? `published (${saved.severity}): ${saved.title}` : 'cleared (blank title)',
    });
    back(res, saved ? 'Announcement published.' : 'Announcement cleared (title was blank).', true);
  })
);

router.post(
  '/announcement/clear',
  asyncHandler(async (req, res) => {
    await clearAnnouncement();
    await recordBotAudit({ actor: actorFor(req), action: 'personalizer:announcement', detail: 'cleared' });
    back(res, 'Announcement cleared.', true);
  })
);

export default router;
