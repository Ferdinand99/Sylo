// JSON API for the Suggestions page of the dashboard: the module's settings, a filterable list, the
// staff decisions, "move back to the suggestions channel" (one, or all) and delete. Shares its rules with /suggestion (modules/suggestions.js).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { accessRouter, seesInboxContent } from '../middleware/access.js';
import { actingUserId, currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { guildTextChannels } from '../lib/discord.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { platformActionLimit } from '../middleware/rateLimit.js';
import {
  STATUSES,
  countSuggestionsOutside,
  getSuggestionByNumber,
  listSuggestions,
  openSuggestionCount,
} from '../../db/suggestions.js';
import {
  ACTIONS,
  STATUS_META,
  canMoveBack,
  decide,
  moveAllSuggestionsBack,
  moveSuggestionBack,
  normaliseReason,
  normaliseSuggestionsConfig,
  removeSuggestion,
} from '../../modules/suggestions.js';

/** How many suggestions the list returns at most. */
const LIST_SHOWN = 100;

const router = accessRouter('/guilds/:guildId', { mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

/**
 * What the list shows. Staff see who wrote an anonymous suggestion; members do not, and neither does
 * someone with View access (`content: false`).
 */
function view(row, guild, cfg, { content = true } = {}) {
  const hidden = row.anonymous && !content;
  const member = row.author_id && !hidden ? guild.members?.cache?.get?.(row.author_id) : null;
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
    authorId: hidden ? null : row.author_id,
    author: row.author_id && !hidden ? (member?.displayName ?? row.author_id) : null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    channelId: row.channel_id,
    // The post sits outside the suggestions channel (an earlier move to the log channel): it can be moved back.
    canMoveBack: canMoveBack(row, cfg),
  };
}

/** The filter the list was asked for; anything unknown falls back to everything, newest first. */
function filterOf(query = {}) {
  const status = query.status === 'open' || STATUSES.includes(query.status) ? query.status : 'all';
  return { status, sort: query.sort === 'top' ? 'top' : 'new' };
}

const settingsOf = async (guildId) =>
  normaliseSuggestionsConfig((await getGuildModule(guildId, 'suggestions')).config);

/**
 * The list, how many suggestions in the whole server could be moved back (the list is cut), and how many
 * are still waiting for a decision (whatever the filter, for the "n open" on the page's tab).
 */
async function listOf(guild, query, content) {
  const cfg = await settingsOf(guild.id);
  const rows = await listSuggestions(guild.id, { ...filterOf(query), limit: LIST_SHOWN });
  return {
    suggestions: rows.map((r) => view(r, guild, cfg, { content })),
    outside: cfg.channel ? await countSuggestionsOutside(guild.id, cfg.channel) : 0,
    openCount: await openSuggestionCount(guild.id),
  };
}

router.get(
  '/modules/suggestions/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await settingsOf(req.guild.id),
      channels: guildTextChannels(req.guild),
      roles: assignableRoles(req.guild),
      ...(await listOf(req.guild, {}, seesInboxContent(req))),
    });
  })
);

router.post(
  '/modules/suggestions/config',
  asyncHandler(async (req, res) => {
    const before = await settingsOf(req.guild.id);
    // A client that does not know the log mode (an older app) keeps what is stored, not the default.
    const stored = (await getGuildModule(req.guild.id, 'suggestions')).config;
    const config = normaliseSuggestionsConfig({
      ...req.body,
      logMode: req.body?.logMode ?? stored?.logMode,
    });
    await setGuildModule(req.guild.id, 'suggestions', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:suggestions',
      detail:
        config.logChannel && config.logMode !== before.logMode
          ? `settings saved, log mode: ${config.logMode}`
          : 'settings saved',
    });
    res.json({ config });
  })
);

router.get(
  '/modules/suggestions/list',
  asyncHandler(async (req, res) => {
    res.json(await listOf(req.guild, req.query, seesInboxContent(req)));
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
    return res.json({
      suggestion: view(fresh, req.guild, await settingsOf(req.guild.id)),
      moved: result.moved,
      copied: result.copied,
      dm: result.dm,
    });
  })
);

// "Move back": the post goes into the suggestions channel again. These two send messages, so they
// share the stricter limit of the routes that publish to the platform.
router.post(
  '/modules/suggestions/move-all-back',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    if (!(await getGuildModule(req.guild.id, 'suggestions')).enabled) {
      return fail(res, 'Turn the Suggestions module on first.');
    }
    const after = Number.isInteger(req.body?.after) && req.body.after > 0 ? req.body.after : 0;
    const result = await moveAllSuggestionsBack(req.guild.id, { after });
    if (result.moved) {
      await recordAudit(req.guild.id, {
        actor: actor(req),
        action: 'module:suggestions',
        detail: `moved back ${result.moved} suggestion${result.moved === 1 ? '' : 's'}`,
      });
    }
    // A stop is an answer, not a failure of the request: the caller needs the counts.
    return res.json({
      moved: result.moved,
      remaining: result.remaining,
      failed: result.failed,
      next: result.next,
      ...(result.ok ? {} : { error: result.error }),
    });
  })
);

router.post(
  '/modules/suggestions/:number/move-back',
  platformActionLimit,
  asyncHandler(async (req, res) => {
    const row = await found(req, res);
    if (!row) return undefined;
    if (!(await getGuildModule(req.guild.id, 'suggestions')).enabled) {
      return fail(res, 'Turn the Suggestions module on first.');
    }
    const result = await moveSuggestionBack(row.id);
    if (!result.ok) return fail(res, result.error);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:suggestions',
      detail: `moved back #${row.number}`,
    });
    const fresh = await getSuggestionByNumber(req.guild.id, row.number);
    return res.json({ suggestion: view(fresh, req.guild, await settingsOf(req.guild.id)) });
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
