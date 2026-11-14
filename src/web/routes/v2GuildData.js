// JSON API for the server-data tools: the config-change audit log, the config export and
// member data (look up / forget a member). Shares its functions and rules through
// lib/guildData.js.
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
import { getAuditEntry, listAuditActions, listAuditPage, recordAudit } from '../../db/audit.js';
import { describeUserData } from '../../db/purge.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import { changeKeys, laterChanges, undoState, undoTarget } from '../../lib/configSnapshot.js';
import { isDeepStrictEqual } from 'node:util';
import {
  UndoError,
  currentSettingsFor,
  mayTouchModule,
  namesFor,
  restoreModule,
  restoreSettings,
  targetOf,
  undoRefusal,
} from '../lib/configUndo.js';

// The audit page loads 50 entries at a time (never more than 100) of the 500 kept per server.
const AUDIT_PAGE = 50;
const AUDIT_PAGE_MAX = 100;
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

// Config change history of this server only: ?limit= (default 50, at most 100), ?before=<id of the last
// entry already shown> for the next page, ?action=<key> for one kind of change. `actions` lists the kinds
// recorded, for the filter.
router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || AUDIT_PAGE, 1),
      AUDIT_PAGE_MAX
    );
    const before = Number.parseInt(String(req.query.before ?? ''), 10) || 0;
    const action = String(req.query.action ?? '').slice(0, 80);
    const { rows, hasMore } = await listAuditPage(req.guild.id, { limit, before, action });
    res.json({
      kept: AUDIT_KEPT,
      hasMore,
      actions: await listAuditActions(req.guild.id),
      entries: rows.map((a) => ({
        id: a.id,
        actor: a.actor,
        action: a.action,
        detail: a.detail,
        at: Number(a.created_at),
        ago: timeAgo(a.created_at),
        // The settings that changed were kept (GET /audit/:id/change shows them), and the entry this one undid.
        hasChange: Number(a.has_change) === 1 && mayViewChange(req, a.action),
        revertsId: a.reverts_id == null ? null : Number(a.reverts_id),
      })),
    });
  })
);

// An operator-only module's settings are shown to operators only, like the config export.
function mayViewChange(req, action) {
  const target = targetOf(action);
  return !target || target.kind !== 'module' || mayTouchModule(target.id, isOwner(req));
}

const entryId = (req) => Number.parseInt(String(req.params.id ?? ''), 10);

// What one entry changed: the settings that differ, before and after (secrets masked), channel and role
// names for the ids in them, and where the saved settings stand now against it, so the page can offer the
// undo and warn when later changes would be lost.
router.get(
  '/audit/:id/change',
  asyncHandler(async (req, res) => {
    const entry = await getAuditEntry(req.guild.id, entryId(req));
    if (!entry || !entry.change || !mayViewChange(req, entry.action)) {
      return fail(res, 'That entry has no saved change.', 404);
    }
    const base = {
      entry: {
        id: entry.id,
        actor: entry.actor,
        action: entry.action,
        detail: entry.detail,
        at: entry.createdAt,
        ago: timeAgo(entry.createdAt),
        revertsId: entry.revertsId,
      },
    };
    if (entry.change.tooLarge) {
      return res.json({
        ...base,
        tooLarge: true,
        undo: { available: false, reason: 'This change was too large to keep a copy of.' },
      });
    }
    const target = targetOf(entry.action);
    const refusal = undoRefusal(target);
    const current = target ? await currentSettingsFor(req.guild, target) : {};
    const state = target ? undoState(current, entry.change) : 'changed';
    res.json({
      ...base,
      before: entry.change.before,
      after: entry.change.after,
      names: namesFor(req.guild, entry.change.before, entry.change.after),
      undo: {
        available: !refusal && state !== 'reverted',
        reason: refusal ?? (state === 'reverted' ? 'The settings already have the earlier values.' : null),
        state,
        laterChanges: state === 'changed' ? laterChanges(current, entry.change) : [],
      },
    });
  })
);

// Put the earlier settings of one entry back. Goes through the module's normaliser and the guarded write,
// then writes an audit entry of its own (with its own before and after). If the settings changed since the
// entry, nothing is restored until the request says `confirm: true`, because those later changes are lost.
router.post(
  '/audit/:id/undo',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const entry = await getAuditEntry(req.guild.id, entryId(req));
    if (!entry || !entry.change || !mayViewChange(req, entry.action)) {
      return fail(res, 'That entry has no saved change.', 404);
    }
    if (entry.change.tooLarge) return fail(res, 'This change was too large to keep a copy of.');
    const target = targetOf(entry.action);
    const refusal = undoRefusal(target);
    if (refusal) return fail(res, refusal);

    const current = await currentSettingsFor(req.guild, target);
    const state = undoState(current, entry.change);
    if (state === 'reverted') {
      return fail(res, 'The settings already have the earlier values.', 409);
    }
    if (state === 'changed' && req.body?.confirm !== true) {
      return res.status(409).json({
        error:
          'These settings were changed again after this entry. Undoing it will lose those later changes.',
        code: 'changed-since',
        laterChanges: laterChanges(current, entry.change),
      });
    }

    // The settings that did not end up as the entry had them (a limit that is lower now, say), for the page.
    let adjusted;
    try {
      if (target.kind === 'settings') {
        const wanted = {};
        for (const key of changeKeys(entry.change)) {
          if (key in entry.change.before) wanted[key] = entry.change.before[key];
        }
        const after = await restoreSettings(req, req.guild, wanted);
        await recordAudit(req.guild.id, {
          actor: moderatorDisplayName(req),
          action: entry.action,
          detail: `undid change #${entry.id}`,
          change: { before: current, after },
          revertsId: entry.id,
        });
        adjusted = Object.keys(wanted).filter((k) => !isDeepStrictEqual(after[k], wanted[k]));
      } else {
        const wanted = undoTarget(current, entry.change);
        const { config } = await restoreModule(req.guild, target.id, wanted);
        await recordAudit(req.guild.id, {
          actor: moderatorDisplayName(req),
          action: entry.action,
          detail: `undid change #${entry.id}`,
          revertsId: entry.id,
        });
        adjusted = changeKeys(entry.change).filter((k) => !isDeepStrictEqual(config[k], wanted[k]));
      }
    } catch (err) {
      if (err instanceof UndoError) return fail(res, err.message, err.status);
      throw err;
    }
    res.json({ ok: true, adjusted });
  })
);

// The server's configuration as a JSON download.
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

// Delete a member's data (moderation cases and other safety records are kept, see
// db/purge.js). Needs `confirm: true` in the body, like the confirmation checkbox.
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
