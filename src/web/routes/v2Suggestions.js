// JSON API for the Suggestions page of the dashboard: the module's settings, a filterable list, and
// the staff decisions and delete. Shares its rules with /suggestion (modules/suggestions.js).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { Router } from 'express';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { STATUSES, getSuggestionByNumber, listSuggestions } from '../../db/suggestions.js';
import {
  ACTIONS,
  STATUS_META,
  decide,
  normaliseReason,
  normaliseSuggestionsConfig,
  removeSuggestion,
} from '../../modules/suggestions.js';

/** How many suggestions the list returns at most. */
const LIST_SHOWN = 100;

const router = Router({ mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

/** What the list shows. Staff see who wrote an anonymous suggestion; members do not. */
function view(row, guild) {
  const member = row.author_id ? guild.members?.cache?.get?.(row.author_id) : null;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    text: row.body,
    status: row.status,
    reason: row.reason,
    up: row.up ?? 0,
    down: row.down ?? 0,
    anonymous: row.anonymous,
    authorId: row.author_id,
    author: row.author_id ? (member?.displayName ?? row.author_id) : null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    channelId: row.channel_id,
  };
}

/** The filter the list was asked for; anything unknown falls back to everything, newest first. */
function filterOf(query = {}) {
  const status = query.status === 'open' || STATUSES.includes(query.status) ? query.status : 'all';
  return { status, sort: query.sort === 'top' ? 'top' : 'new' };
}

const listOf = async (guild, query) =>
  (await listSuggestions(guild.id, { ...filterOf(query), limit: LIST_SHOWN })).map((r) => view(r, guild));

const settingsOf = async (guildId) =>
  normaliseSuggestionsConfig((await getGuildModule(guildId, 'suggestions')).config);

router.get(
  '/modules/suggestions/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await settingsOf(req.guild.id),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      suggestions: await listOf(req.guild, {}),
    });
  })
);

router.post(
  '/modules/suggestions/config',
  asyncHandler(async (req, res) => {
    const config = normaliseSuggestionsConfig(req.body);
    await setGuildModule(req.guild.id, 'suggestions', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:suggestions',
      detail: 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/modules/suggestions/list',
  asyncHandler(async (req, res) => {
    res.json({ suggestions: await listOf(req.guild, req.query) });
  })
);

/** The suggestion named in the URL, or a 404 already sent. */
async function found(req, res) {
  const number = Number(req.params.number);
  const row =
    Number.isInteger(number) && number > 0 ? await getSuggestionByNumber(req.guild.id, number) : null;
  if (!row) fail(res, 'No such suggestion.', 404);
  return row;
}

router.post(
  '/modules/suggestions/:number/decision',
  asyncHandler(async (req, res) => {
    const row = await found(req, res);
    if (!row) return undefined;
    const action = String(req.body?.action ?? '');
    if (!Object.hasOwn(ACTIONS, action)) {
      return fail(res, `Pick one of: ${Object.keys(ACTIONS).join(', ')}.`);
    }
    if (!(await getGuildModule(req.guild.id, 'suggestions')).enabled) {
      return fail(res, 'Turn the Suggestions module on first.');
    }
    const reason = normaliseReason(req.body?.reason);
    const result = await decide(row, action, { reason, by: actingUserId(req, req.guild.id, null) });
    if (!result.ok) return fail(res, result.error);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:suggestions',
      detail: `${STATUS_META[result.status].label.toLowerCase()} #${row.number}`,
    });
    const fresh = await getSuggestionByNumber(req.guild.id, row.number);
    return res.json({ suggestion: view(fresh, req.guild), moved: result.moved, dm: result.dm });
  })
);

router.post(
  '/modules/suggestions/:number/delete',
  asyncHandler(async (req, res) => {
    const row = await found(req, res);
    if (!row) return undefined;
    await removeSuggestion(row);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:suggestions',
      detail: `deleted #${row.number}`,
    });
    return res.json({ ok: true });
  })
);

export default router;
