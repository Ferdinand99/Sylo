// JSON API for the Quote board page of the dashboard: the module's settings, a searchable list of
// the saved quotes, and remove. Shares its rules with /quote (modules/quoteBoard.js).
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set, the caller
// manages this server and the state-changing calls have passed the CSRF check.
import { Router } from 'express';
import { currentUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { assignableRoles } from '../lib/guildContext.js';
import { recordAudit } from '../../db/audit.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import { getQuoteByNumber, quoteCount, recentQuotes, searchQuotes } from '../../db/quotes.js';
import {
  jumpUrl,
  normaliseQuoteBoardConfig,
  normaliseQuoteQuery,
  removeQuote,
} from '../../modules/quoteBoard.js';

/** How many quotes the list returns at most. */
const LIST_SHOWN = 100;

const router = Router({ mergeParams: true });

const actor = (req) => (currentUser(req)?.open ? 'Dashboard' : `${currentUser(req).name} (dashboard)`);
const fail = (res, message, status = 400) => res.status(status).json({ error: message });

function view(row, guild) {
  return {
    number: row.number,
    authorId: row.author_id,
    author: row.author_name,
    text: row.body,
    attachments: row.attachments,
    channelId: row.channel_id,
    channel: guild.channels?.cache?.get?.(row.channel_id)?.name ?? null,
    messageAt: row.message_at,
    savedBy: row.saved_by,
    savedAt: row.saved_at,
    // on the public page only when it came from a channel everyone can read
    publicSource: row.public_source === 1,
    url: jumpUrl(guild.id, row.channel_id, row.message_id),
  };
}

/** The list for the page: the newest quotes, or those matching the text (quote or author name). */
async function listOf(guild, query = {}) {
  const q = normaliseQuoteQuery(query.q);
  const rows = q
    ? await searchQuotes(guild.id, q, LIST_SHOWN)
    : await recentQuotes(guild.id, { limit: LIST_SHOWN });
  return { total: await quoteCount(guild.id), quotes: rows.map((r) => view(r, guild)) };
}

const settingsOf = async (guildId) =>
  normaliseQuoteBoardConfig((await getGuildModule(guildId, 'quote-board')).config);

router.get(
  '/modules/quote-board/config',
  asyncHandler(async (req, res) => {
    res.json({
      config: await settingsOf(req.guild.id),
      roles: assignableRoles(req.guild),
      publicPath: `/quotes/${encodeURIComponent(req.guild.id)}`,
      ...(await listOf(req.guild)),
    });
  })
);

router.post(
  '/modules/quote-board/config',
  asyncHandler(async (req, res) => {
    const prev = await settingsOf(req.guild.id);
    const config = normaliseQuoteBoardConfig(req.body);
    await setGuildModule(req.guild.id, 'quote-board', { config });
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:quote-board',
      detail:
        prev.publicPage === config.publicPage
          ? 'settings saved'
          : `public page ${config.publicPage ? 'on' : 'off'}`,
    });
    res.json({ config });
  })
);

router.get(
  '/modules/quote-board/list',
  asyncHandler(async (req, res) => {
    res.json(await listOf(req.guild, req.query));
  })
);

router.post(
  '/modules/quote-board/:number/delete',
  asyncHandler(async (req, res) => {
    const number = Number(req.params.number);
    const row = Number.isInteger(number) && number > 0 ? await getQuoteByNumber(req.guild.id, number) : null;
    if (!row) return fail(res, 'No such quote.', 404);
    await removeQuote(row);
    await recordAudit(req.guild.id, {
      actor: actor(req),
      action: 'module:quote-board',
      detail: `removed quote #${row.number}`,
    });
    return res.json({ ok: true });
  })
);

export default router;
