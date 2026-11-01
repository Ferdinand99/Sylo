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
// The page makes a visitor's browser call nobody but Sylo. The server's icon and the event's image
// are fetched by Sylo and served at /events/<token>/icon and /events/<token>/image
// (modules/lib/eventImage.js), so the HTML holds only those two addresses: no third-party host and
// none of the ids in a Discord image link. An image that cannot be fetched is left out of the page.
//
// There is a page, and an image, only while all of this is true, checked on every request and never
// remembered:
//   - the Events module is on and "Public event pages" is on;
//   - the event's channel is one @everyone can see. If Sylo cannot tell (the channel is not in its
//     cache, the permissions cannot be read), there is no page: it fails closed. A channel made
//     private later takes the page down on the next request.
// Every reason there is no page answers with the same 404 page, so the response does not tell
// which addresses exist, which servers Sylo is in, or why. The image addresses answer the same way.
import { Router } from 'express';
import { guildByKey } from '../../platform/platformOf.js';
import { getGuildModule } from '../../db/modules.js';
import { eventStatusCount, getEventByToken } from '../../db/events.js';
import { publicText } from '../../modules/quoteBoard.js';
import { EVENT_TOKEN_RE, channelIsPublic, eventPagesOn, eventStatus } from '../../modules/lib/eventPage.js';
import { loadImage } from '../../modules/lib/eventImage.js';

const NOT_FOUND = 'There is no public event page at this address.';

// A page of its own, not the dashboard's error page: that one loads the visit-count script, which
// would send the address, token included, to the stats service.
function notFound(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(404).render('event-missing', { message: NOT_FOUND });
}

const LABELS = { upcoming: 'Upcoming', cancelled: 'Cancelled', ended: 'Ended' };

/** "2030-01-05 18:00 UTC": what the page shows until its script rewrites the time in the visitor's zone. */
const utcText = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const moment = (ms) => ({ iso: new Date(ms).toISOString(), text: utcText(ms) });

/** The address of the server's icon on the platform's CDN, or null. Only ever fetched by Sylo. */
function iconLink(guild) {
  try {
    return guild.iconURL?.({ size: 128, extension: 'png', forceStatic: true }) ?? null;
  } catch {
    return null;
  }
}

/**
 * The event and server behind a token while the page is allowed to exist, or null. Every request
 * of this router starts here, so the page and its images have one set of rules.
 */
async function openEvent(token) {
  if (!EVENT_TOKEN_RE.test(token)) return null;
  const ev = await getEventByToken(token);
  if (!ev) return null;
  const guild = guildByKey(ev.guild_id);
  if (!guild) return null;
  if (!eventPagesOn(await getGuildModule(ev.guild_id, 'events'))) return null;
  if (!channelIsPublic(guild, ev.channel_id)) return null;
  return { ev, guild };
}

const router = Router();

router.get('/:token', async (req, res, next) => {
  try {
    const open = await openEvent(req.params.token);
    if (!open) return notFound(res);
    const { ev, guild } = open;
    const { token } = req.params;

    const [going, maybe, icon, image] = await Promise.all([
      eventStatusCount(ev.id, 'join'),
      eventStatusCount(ev.id, 'maybe'),
      loadImage(iconLink(guild)),
      loadImage(ev.image_url),
    ]);
    const status = eventStatus(ev);
    // The posted time changes as people edit; the page must not be served from a cache after the
    // event was cancelled, the setting was switched off or the channel was closed.
    res.set('Cache-Control', 'no-store');
    res.render('event', {
      guild: { name: guild.name, icon: icon ? `/events/${token}/icon` : null },
      event: {
        title: publicText(ev.title),
        description: publicText(ev.description),
        location: publicText(ev.location),
        image: image ? `/events/${token}/image` : null,
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

// The two images of a page, served from Sylo. Same checks as the page, same not-found.
router.get('/:token/:asset', async (req, res, next) => {
  try {
    const { asset } = req.params;
    if (asset !== 'icon' && asset !== 'image') return notFound(res);
    const open = await openEvent(req.params.token);
    if (!open) return notFound(res);
    const image = await loadImage(asset === 'icon' ? iconLink(open.guild) : open.ev.image_url);
    if (!image) return notFound(res);
    res.set({
      'Content-Type': image.type,
      'Content-Length': String(image.body.length),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      // Short and private: a page that goes away must not live on in a browser for long.
      'Cache-Control': 'private, max-age=60',
    });
    res.end(image.body);
  } catch (err) {
    next(err);
  }
});

export default router;
