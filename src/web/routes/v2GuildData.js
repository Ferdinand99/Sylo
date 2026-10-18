// V2 JSON API for the server-data tools that used to exist only in V1: the config-change
// audit log, the config export and member data (look up / forget a member). Same functions
// and rules as V1's guilds.js (shared through lib/guildData.js), answering with JSON.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set and the
// caller manages this server.
import { Router } from 'express';
import { currentUser, isOwner } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { timeAgo } from '../lib/format.js';
import {
  exportGuildConfigFor,
  forgetMember,
  lookupProfile,
  MEMBER_DATA_UNAFFECTED,
} from '../lib/guildData.js';
import { listAudit } from '../../db/audit.js';
import { describeUserData } from '../../db/purge.js';

// Same as V1's audit page: the newest 150 of the 500 kept per server.
const AUDIT_SHOWN = 150;
const AUDIT_KEPT = 500;

const fail = (res, message, status = 400) => res.status(status).json({ error: message });

const moderatorDisplayName = (req) =>
  currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`;

// Mirrors guilds.js's private parseUserId() — a raw snowflake or an `<@id>`/`<@!id>` mention.
function parseUserId(raw) {
  const m = String(raw ?? '')
    .trim()
    .match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/);
  return m ? m[1] || m[2] : null;
}

const router = Router({ mergeParams: true });

// Config change history.
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const rows = await listAudit(req.guild.id, AUDIT_SHOWN);
    res.json({
      kept: AUDIT_KEPT,
      entries: rows.map((a) => ({
        id: a.id,
        actor: a.actor,
        action: a.action,
        detail: a.detail,
        at: Number(a.created_at),
        ago: timeAgo(a.created_at),
      })),
    });
  })
);

// The server's configuration as a JSON download — same file as V1's /guilds/:id/export.
router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const data = await exportGuildConfigFor(req.guild.id, { owner: isOwner(req) });
    res.setHeader('Content-Disposition', `attachment; filename="sylo-${req.guild.id}-config.json"`);
    res.type('application/json').send(JSON.stringify(data, null, 2));
  })
);

// What Sylo stores about one member (counts per source). No ?user → nothing looked up yet.
router.get(
  '/member-data',
  asyncHandler(async (req, res) => {
    const raw = String(req.query.user ?? '').trim();
    if (!raw) return res.json({ lookup: null, unaffected: MEMBER_DATA_UNAFFECTED });
    const userId = parseUserId(raw);
    if (!userId) return fail(res, `“${raw.slice(0, 100)}” is not a valid user ID or mention.`);
    res.json({
      lookup: {
        profile: await lookupProfile(req.guild, userId),
        data: await describeUserData(req.guild.id, userId),
      },
      unaffected: MEMBER_DATA_UNAFFECTED,
    });
  })
);

// Delete a member's data (moderation cases and other safety records are kept, as in V1 and
// db/purge.js). Needs `confirm: true` in the body, like V1's confirmation checkbox.
router.post(
  '/member-data/forget',
  asyncHandler(async (req, res) => {
    const userId = parseUserId(req.body?.userId);
    if (!userId) return fail(res, 'Enter a valid user ID or @mention.');
    if (req.body?.confirm !== true) return fail(res, 'Confirm that you want to delete the member’s data.');
    const reason = String(req.body?.reason ?? '')
      .trim()
      .slice(0, 500);
    const { result, dmDelivered } = await forgetMember(req.guild, userId, {
      reason,
      actor: moderatorDisplayName(req),
    });
    res.json({ ok: true, userId, result, dmDelivered });
  })
);

export default router;
