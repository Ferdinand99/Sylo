// Public (no-auth) page with a server's latest saved quotes, at /quotes/<guildId>. Off by default:
// the server switches it on in the Quote board settings. Mounted before requireAuth in server.js.
//
// What it shows is deliberately less than the bot does: the text with mentions, channels, emoji
// and message links turned into words, the author's display name as saved, the quote's number and
// date. No user, channel or message ids, no avatars, and no jump links (a jump link only works for
// members of the server and would carry the ids; the leaderboard page links nowhere either).
// Quotes saved from a channel that @everyone cannot read are never listed.
import { Router } from 'express';
import { guildByKey } from '../../platform/platformOf.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import { getGuildModule } from '../../db/modules.js';
import { publicQuoteCount, recentPublicQuotes } from '../../db/quotes.js';
import { normaliseQuoteBoardConfig, publicText } from '../../modules/quoteBoard.js';

export const PAGE_SIZE = 50;

// One answer for every reason there is no page (a malformed id, a server Sylo is not in, a module
// that is off, a page that is not switched on), so the response does not tell which server ids
// Sylo is in.
const NOT_FOUND = 'There is no public quote page at this address.';

function notFound(res) {
  return res.status(404).render('error', {
    title: 'Quotes unavailable',
    heading: 'No quotes here',
    message: NOT_FOUND,
  });
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const router = Router();
router.get('/:guildId', async (req, res, next) => {
  try {
    const { guildId } = req.params;
    if (!isPlatformGuildId(guildId)) return notFound(res);
    const guild = guildByKey(guildId);
    if (!guild) return notFound(res);

    const mod = await getGuildModule(guildId, 'quote-board');
    if (!mod.enabled || normaliseQuoteBoardConfig(mod.config).publicPage !== true) {
      return notFound(res);
    }

    const total = await publicQuoteCount(guildId);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    const rows = await recentPublicQuotes(guildId, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });

    res.render('quotes', {
      guild: { name: guild.name, icon: guild.iconURL?.({ size: 64 }) ?? null },
      quotes: rows.map((r) => ({
        number: r.number,
        author: r.author_name || 'Unknown',
        text: publicText(r.body),
        attachments: r.attachments,
        date: day(r.message_at),
      })),
      page,
      pages,
      total,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
