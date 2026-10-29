// Public (no-auth) page with a server's latest saved quotes, at /quotes/<guildId>. Off by default:
// the server switches it on in the Quote board settings. Mounted before requireAuth in server.js.
//
// What it shows is deliberately less than the bot does: the text with mentions, channels, emoji
// and message links turned into words, the author's display name as saved, the quote's number and
// date. No user, channel or message ids, no avatars, and no jump links (a jump link only works for
// members of the server and would carry the ids; the leaderboard page links nowhere either).
// Quotes saved from a channel that @everyone cannot read are never listed, and neither are quotes
// from a channel that has become private since (re-checked when the page is drawn, see
// nowPrivateChannels).
import { Router } from 'express';
import { guildByKey } from '../../platform/platformOf.js';
import { isPlatformGuildId } from '../../lib/platformId.js';
import { getGuildModule } from '../../db/modules.js';
import { publicQuoteChannels, publicQuoteCount, recentPublicQuotes } from '../../db/quotes.js';
import { normaliseQuoteBoardConfig, nowPrivateChannels, publicText } from '../../modules/quoteBoard.js';

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

/**
 * One page of the quotes still public, newest first, and how many there are. Quotes from the
 * `hidden` channels are skipped; without any, this is a plain page query.
 */
async function visiblePage(guildId, hidden, hiddenCount, { page, limit }) {
  const total = (await publicQuoteCount(guildId)) - hiddenCount;
  const pages = Math.max(1, Math.ceil(total / limit));
  const at = Math.min(pages, page);
  const offset = (at - 1) * limit;
  if (hidden.size === 0)
    return { total, pages, page: at, rows: await recentPublicQuotes(guildId, { limit, offset }) };
  // Some channels are hidden: read on in batches, skipping their quotes, until the page is full.
  const rows = [];
  let skipped = 0;
  for (let from = 0; rows.length < limit; from += 200) {
    const batch = await recentPublicQuotes(guildId, { limit: 200, offset: from });
    if (batch.length === 0) break;
    for (const row of batch) {
      if (hidden.has(row.channel_id)) continue;
      if (skipped < offset) skipped += 1;
      else if (rows.length < limit) rows.push(row);
    }
  }
  return { total, pages, page: at, rows };
}

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

    // A channel that was public when its quote was saved may not be now: hide those quotes.
    const channels = await publicQuoteChannels(guildId);
    const hidden = nowPrivateChannels(
      guild,
      guildId,
      channels.map((c) => c.channelId)
    );
    const hiddenCount = channels.filter((c) => hidden.has(c.channelId)).reduce((n, c) => n + c.count, 0);
    const { total, pages, page, rows } = await visiblePage(guildId, hidden, hiddenCount, {
      page: Math.max(1, parseInt(req.query.page, 10) || 1),
      limit: PAGE_SIZE,
    });

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
