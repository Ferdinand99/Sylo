// The page of one event, at /events/<token>. Off by default: the server switches it on with
// "Event pages" in the Events settings (stored as publicPages). Mounted before requireAuth in
// server.js, with the same kind of rate limit as the quote page and the leaderboard.
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
//   - the Events module is on and "Event pages" is on;
//   - the event's channel has an audience (modules/lib/eventPage.js, channelAudience):
//       public   @everyone can see the channel: anyone with the link may open the page;
//       private  only some members see it: the visitor must be signed in with the platform the event
//                was posted on (Discord or Fluxer, the dashboard's own login), be a member of that
//                server and be able to see that channel, by the bot's live data of that moment;
//       none     an age-restricted channel, a private thread, or one Sylo cannot see: no page for
//                anyone, signed in or not.
//     If Sylo cannot tell, there is no page: it fails closed. A channel made private later moves
//     the page to sign-in on the next request, and a person who loses access loses the page on the
//     next request.
//
// What a visitor is told, so that the response never shows which addresses are events, in which
// servers, or why:
//   - the page, while it is allowed;
//   - otherwise, a visitor who is not signed in gets one neutral sign-in page (401), whatever the
//     reason: a private event, an unknown address, a channel that is age-restricted, the setting
//     off. It holds no title, server, image or event data, and no link-preview tags. The platform
//     it offers is the event's own; for an address that is not an event, a platform picked from the
//     address with a secret key, so that the choice is no sign of whether an event exists;
//   - otherwise (signed in, or no sign-in is possible), the same 404 page for every reason: no
//     access, a wrong address, a setting that is off, an age-restricted channel, an event posted on
//     the other platform than the one the person signed in with.
// The sign-in link returns to /events/<token> by the dashboard's own login, which accepts only a
// path on this site (middleware/auth.js, internalNext).
import { createHmac } from 'node:crypto';
import { Router } from 'express';
import { config } from '../../config.js';
import { guildByKey, platformOfGuild } from '../../platform/platformOf.js';
import { getGuildModule } from '../../db/modules.js';
import { eventStatusCount, getEventByToken } from '../../db/events.js';
import { publicText } from '../../modules/quoteBoard.js';
import {
  EVENT_TOKEN_RE,
  channelAudience,
  eventPagesOn,
  eventStatus,
  platformOfKey,
  viewerMaySee,
} from '../../modules/lib/eventPage.js';
import { loadImage } from '../../modules/lib/eventImage.js';
import { identityFor } from '../lib/accountAuth.js';
import { enabledProviders } from '../lib/oauthProviders.js';

const NOT_FOUND = 'There is no event page at this address.';

/**
 * Headers for everything the sign-in rule can change: the page, its images, the sign-in page and
 * the not-found page. The same address answers differently for different people, so nothing may be
 * kept by a browser or a proxy, nothing is indexed, and the address does not travel as a referrer.
 */
function privateHeaders(res) {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
  });
  res.vary('Cookie');
}

// A page of its own, not the dashboard's error page: that one loads the visit-count script, which
// would send the address, token included, to the stats service.
function notFound(res) {
  privateHeaders(res);
  return res.status(404).render('event-missing', { message: NOT_FOUND });
}

/**
 * The neutral sign-in page. It says nothing about the event, and it carries no title, server, image
 * or preview tag. The link goes through the dashboard's login and comes back to the page; the token
 * in it has passed EVENT_TOKEN_RE, so it is 32 hex characters and the path is always on this site.
 */
function signInPage(res, provider, token) {
  privateHeaders(res);
  return res.status(401).render('event-signin', {
    label: provider.label,
    href: `/auth/${provider.platform}/login?next=/events/${token}`,
  });
}

/**
 * Which login to offer for an address. For an event, the platform it was posted on, if that login
 * is offered. For an address that is no event, one of the offered logins picked by a keyed hash of
 * the address: the same address always gets the same one, and nobody without the key can tell it
 * from an event's own platform.
 */
function signInProvider(ev, token) {
  const offered = enabledProviders();
  if (ev) return offered.find((p) => p.platform === platformOfKey(ev.guild_id)) ?? null;
  if (!offered.length) return null;
  const pick = createHmac('sha256', config.sessionSecret).update(`event-signin|${token}`).digest()[0];
  return offered[pick % offered.length];
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

const NONE = { type: 'none' };

/**
 * What this request may have: `{ type: 'page', ev, guild, audience }` while the page is allowed for
 * this visitor, `{ type: 'signin', provider }` for the neutral sign-in page, or `{ type: 'none' }`
 * for the not-found page. Every request of this router starts here, so the page and its images
 * have one set of rules, and no answer is kept from one request to the next.
 */
async function openEvent(req) {
  const { token } = req.params;
  if (!EVENT_TOKEN_RE.test(token)) return NONE;
  const ev = await getEventByToken(token);
  const guild = ev ? guildByKey(ev.guild_id) : null;
  let audience = 'none';
  if (ev && guild && eventPagesOn(await getGuildModule(ev.guild_id, 'events'))) {
    audience = channelAudience(guild, ev.channel_id);
  }
  if (audience === 'public') return { type: 'page', ev, guild, audience };

  // Everything else needs a signed-in visitor. With no login (open mode) there is nobody to ask.
  if (!config.authEnabled) return NONE;
  const provider = signInProvider(ev, token);
  if (!provider) return NONE;
  // Only the browser's own session counts, never an app token.
  if (!req.account || req.viaToken) return { type: 'signin', provider };
  // Signed in: only the identity on the platform the event was posted on counts, so a Discord id
  // is never looked up in a Fluxer server. A person with none there is refused like anyone else.
  const identity = identityFor(req.account, provider.platform);
  if (!identity) return NONE;

  if (audience !== 'private' || platformOfGuild(guild) !== provider.platform) return NONE;
  if (!(await viewerMaySee(guild, ev.channel_id, identity.platformUserId))) return NONE;
  return { type: 'page', ev, guild, audience };
}

/** Answer a request that has no page: the sign-in page or the not-found page. */
function refuse(res, open, token) {
  return open.type === 'signin' ? signInPage(res, open.provider, token) : notFound(res);
}

const router = Router();

router.get('/:token', async (req, res, next) => {
  try {
    const open = await openEvent(req);
    const { token } = req.params;
    if (open.type !== 'page') return refuse(res, open, token);
    const { ev, guild } = open;

    const [going, maybe, icon, image] = await Promise.all([
      eventStatusCount(ev.id, 'join'),
      eventStatusCount(ev.id, 'maybe'),
      loadImage(iconLink(guild)),
      loadImage(ev.image_url),
    ]);
    const status = eventStatus(ev);
    // The posted time changes as people edit; the page must not be served from a cache after the
    // event was cancelled, the setting was switched off or the channel was closed. A page that only
    // some visitors may open is also private to the browser that got it.
    if (open.audience === 'private') privateHeaders(res);
    else res.set('Cache-Control', 'no-store');
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

// The two images of a page, served from Sylo. Same checks as the page, same answers. The bytes are
// read from Sylo's own image cache (modules/lib/eventImage.js) only after the checks passed, so a
// person without access never gets them, and an image of a private event is not kept by a browser.
router.get('/:token/:asset', async (req, res, next) => {
  try {
    const { token, asset } = req.params;
    if (asset !== 'icon' && asset !== 'image') return notFound(res);
    const open = await openEvent(req);
    if (open.type !== 'page') return refuse(res, open, token);
    const image = await loadImage(asset === 'icon' ? iconLink(open.guild) : open.ev.image_url);
    if (!image) return notFound(res);
    res.set({
      'Content-Type': image.type,
      'Content-Length': String(image.body.length),
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      // Short and private: a page that goes away must not live on in a browser for long. An image
      // of a page that only some may open is not kept at all.
      'Cache-Control': open.audience === 'private' ? 'private, no-store' : 'private, max-age=60',
    });
    if (open.audience === 'private') {
      res.set({ 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' });
      res.vary('Cookie');
    }
    res.end(image.body);
  } catch (err) {
    next(err);
  }
});

export default router;
