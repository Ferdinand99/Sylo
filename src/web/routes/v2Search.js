// JSON API behind the dashboard's command palette: look up an inbox item (ticket, suggestion, appeal or
// application) of this server by its number.
//
// Mounted at /guilds/:guildId AFTER the admin guard in v2Api.js, so req.guild is set and the caller
// manages this server. Every lookup is keyed by the server's own id, so a number that belongs to
// another server is never found. The answer holds no message text, no answers and no member data:
// only what the palette needs to name the item and open its page.
import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getTicket } from '../../db/tickets.js';
import { getAppeal } from '../../db/appeals.js';
import { getSubmission } from '../../db/applications.js';
import { getSuggestionByNumber } from '../../db/suggestions.js';

const router = Router({ mergeParams: true });

// Each press of a key in the palette can ask: the budget is for typing, not for scanning.
const searchLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many searches — wait a moment.',
});

// "12", "#12", "ticket 12", "suggestion #5": an optional kind, then a number. Anything else finds nothing.
const QUERY = /^(?:(ticket|suggestion|appeal|application)s?\s*)?#?\s*(\d{1,9})$/i;

/** The kind and number a query names, or null. `kind` is null when only a number was typed. */
export function parseInboxQuery(raw) {
  const m = QUERY.exec(
    String(raw ?? '')
      .trim()
      .slice(0, 40)
  );
  if (!m) return null;
  const number = Number(m[2]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { kind: m[1] ? m[1].toLowerCase() : null, number };
}

const KINDS = {
  ticket: async (guildId, n) => {
    const t = await getTicket(n);
    return t && t.guild_id === guildId
      ? { kind: 'ticket', number: t.id, status: t.status, href: `/guilds/${guildId}/tickets/${t.id}` }
      : null;
  },
  suggestion: async (guildId, n) => {
    const s = await getSuggestionByNumber(guildId, n);
    return s
      ? { kind: 'suggestion', number: s.number, status: s.status, href: `/guilds/${guildId}/m/suggestions` }
      : null;
  },
  appeal: async (guildId, n) => {
    const a = await getAppeal(guildId, n);
    return a
      ? { kind: 'appeal', number: Number(a.id), status: a.status, href: `/guilds/${guildId}/appeals` }
      : null;
  },
  application: async (guildId, n) => {
    const s = await getSubmission(guildId, n);
    return s
      ? {
          kind: 'application',
          number: s.id,
          status: s.status,
          href: `/guilds/${guildId}/applications/${s.id}`,
        }
      : null;
  },
};

router.get(
  '/search/inbox',
  searchLimit,
  asyncHandler(async (req, res) => {
    const parsed = parseInboxQuery(req.query.q);
    if (!parsed) return res.json({ items: [] });
    const kinds = parsed.kind ? [parsed.kind] : Object.keys(KINDS);
    const items = [];
    for (const kind of kinds) {
      const item = await KINDS[kind](req.guild.id, parsed.number);
      if (item) items.push(item);
    }
    res.json({ items });
  })
);

export default router;
