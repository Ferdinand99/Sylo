// JSON API for the server-data tools: the config-change audit log, the config export and
// member data (look up / forget a member). Shares its functions and rules through
// lib/guildData.js.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set and the
// caller manages this server.
import { accessRouter } from '../middleware/access.js';
import { currentUser, isOwner } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { timeAgo } from '../lib/format.js';
import { searchMembers } from '../lib/memberSearch.js';
import { clientKey, rateLimit } from '../middleware/rateLimit.js';
import {
  exportGuildConfigFor,
  forgetMember,
  lookupProfile,
  MEMBER_DATA_UNAFFECTED,
} from '../lib/guildData.js';
import { getAuditEntry, listAuditActions, listAuditPage, recordAudit } from '../../db/audit.js';
import { describeUserData } from '../../db/purge.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import {
  UndoError,
  describeUndo,
  mayTouchModule,
  namesFor,
  targetOf,
  undoModule,
  undoSettings,
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

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

// Search as you type from a member picker, one count per person and server. Generous, because the
// picker asks on every pause in typing; it mainly bounds the live lookups of pasted ids.
const memberSearchLimit = rateLimit({
  windowMs: 60_000,
  max: 100,
  keyFn: (req) => `member-search|${req.params.guildId}|${req.account?.id ?? clientKey(req)}`,
});

// Members of this server by name or one pasted id, for a member picker (the Sylo app's). The same
// answer as the Temporary roles search: at most 25, never a bot, cached members by name and an
// exact id looked up live.
router.get(
  '/members',
  memberSearchLimit,
  asyncHandler(async (req, res) => {
    res.json({ members: await searchMembers(req.guild, req.query.q) });
  })
);

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

// What one entry changed: the settings that differ, before and after (secrets masked), channel, role and member
// names for the ids in them, and where the saved settings stand now against it, so the page can offer the
// undo and warn when later changes would be lost. `undo.notRestored` are the settings an undo leaves alone, and why.
router.get(
  '/audit/:id/change',
  asyncHandler(async (req, res) => {
    const entry = await getAuditEntry(req.guild.id, entryId(req));
    if (!entry || !entry.change || !mayViewChange(req, entry.action)) {
      return fail(res, 'That entry has no saved change.', 404);
    }
    const target = targetOf(entry.action);
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
      // What is being changed: a module's settings or the server settings (the page words its hints by it).
      kind: target?.kind ?? null,
    };
    if (entry.change.tooLarge) {
      return res.json({
        ...base,
        tooLarge: true,
        undo: { available: false, reason: 'This change was too large to keep a copy of.' },
      });
    }
    res.json({
      ...base,
      before: entry.change.before,
      after: entry.change.after,
      names: namesFor(req.guild, entry.change.before, entry.change.after),
      undo: await describeUndo(req.guild, target, entry.change),
    });
  })
);

// Put the earlier settings of one entry back. Goes through the module's normaliser and the guarded write (or,
// for the server settings, the checks of the settings form), then writes an audit entry of its own (with its own
// before and after). If the settings changed since the entry, nothing is restored until the request says
// `confirm: true` with the `token` the refusal (or the entry's view) gave, which names the state the person
// confirmed.
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
    if (!target) return fail(res, 'This kind of entry has no saved settings to restore.');
    const opts = { confirm: req.body?.confirm === true, token: String(req.body?.token ?? '') };
    let result;
    try {
      result =
        target.kind === 'settings'
          ? await undoSettings(req, req.guild, entry.change, opts)
          : await undoModule(req.guild, target.id, entry.change, opts);
    } catch (err) {
      if (err instanceof UndoError) return res.status(err.status).json({ error: err.message, ...err.extra });
      throw err;
    }
    // The entry of the undo itself: the audit entry takes what the request changed (src/db/auditCapture.js).
    await recordAudit(req.guild.id, {
      actor: moderatorDisplayName(req),
      action: entry.action,
      detail: `undid change #${entry.id}`,
      revertsId: entry.id,
    });
    res.json({ ok: true, adjusted: result.adjusted, notRestored: result.notRestored.map((n) => n.key) });
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
