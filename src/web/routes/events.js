// Public (no-auth) page of one event, at /events/<token>. Off by default: the server switches it on
// with "Public event pages" in the Events settings. Mounted before requireAuth in server.js, with the
// same kind of rate limit as the quote page and the leaderboard.
//
// The address is a random 128-bit token stored on the event (db/events.js). The event number runs in
// sequence and is never an address.
//
// What it shows is deliberately less than the post in the server: the title, the time, the place, the
// description, the image, the capacity, how many are going and how many maybe, and whether the event
// is upcoming, cancelled or over. No names, no ids, no host, no participant role, no channel. Mentions,
// channels and message links written into the text are turned into words (publicText).
//
// There is a page only while all of this is true, checked on every request and never remembered:
//   - the Events module is on and "Public event pages" is on;
//   - the event's channel is one @everyone can see. If Sylo cannot tell (the channel is not in its
//     cache, the permissions cannot be read), there is no page: it fails closed. A channel made
//     private later takes the page down on the next request.
// Every reason there is no page answers with the same 404 page, so the response does not tell
// which addresses exist, which servers Sylo is in, or why.
import { Router } from 'express';
import { guildByKey } from '../../platform/platformOf.js';
import { getGuildModule } from '../../db/modules.js';
import { eventStatusCount, getEventByToken } from '../../db/events.js';
import { publicText } from '../../modules/quoteBoard.js';
import {
  EVENT_TOKEN_RE,
  channelIsPublic,
  eventPagesOn,
  eventStatus,
  trustedImageUrl,
} from '../../modules/lib/eventPage.js';

const NOT_FOUND = 'There is no public event page at this address.';

function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).render('error', {
    title: 'Event unavailable',
    heading: 'No event here',
    message: NOT_FOUND,
  });
}

const LABELS = { upcoming: 'Upcoming', cancelled: 'Cancelled', ended: 'Ended' };

/** "2030-01-05 18:00 UTC": what the page shows until its script rewrites the time in the visitor's zone. */
const utcText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const moment = (ms) => ({ iso: new Date(ms).toISOString(), text: utcText(ms) });

const router = Router();
router.get('/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!EVENT_TOKEN_RE.test(token)) return notFound(res);
    const ev = await getEventByToken(token);
    if (!ev) return notFound(res);
    const guild = guildByKey(ev.guild_id);
    if (!guild) return notFound(res);

    if (!eventPagesOn(await getGuildModule(ev.guild_id, 'events'))) return notFound(res);
    if (!channelIsPublic(guild, ev.channel_id)) return notFound(res);

    const [going, maybe] = await Promise.all([
      eventStatusCount(ev.id, 'join'),
      eventStatusCount(ev.id, 'maybe'),
    ]);
    const status = eventStatus(ev);
    // The posted time changes as people edit; the page must not be served from a cache after the
    // event was cancelled, the setting was switched off or the channel was closed.
    res.set('Cache-Control', 'no-store');
    res.render('event', {
      guild: { name: guild.name, icon: guild.iconURL?.({ size: 64 }) ?? null },
      event: {
        title: publicText(ev.title),
        description: publicText(ev.description),
        location: publicText(ev.location),
        image: trustedImageUrl(ev.image_url),
        status,
        statusLabel: LABELS[status],
        start: moment(ev.start_at),
        end: ev.end_at ? moment(ev.end_at) : null,
        going,
        maybe,
        capacity: ev.capacity,
        full: Boolean(ev.capacity) && going >= ev.capacity,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
