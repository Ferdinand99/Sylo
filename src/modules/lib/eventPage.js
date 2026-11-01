// The rules behind the public page of an event (src/web/routes/events.js, and the link in the post
// in src/modules/events.js). Kept here, apart from both, so the post and the page decide the same.
//
// A page exists for an event only while all of these hold, and the page route checks every one of
// them on every request:
//   - the Events module is on and its "Public event pages" setting is a real `true`;
//   - the event's channel is one @everyone can see (channelIsPublic, which fails closed).
import { config } from '../../config.js';
import { END_GRACE_MS } from '../../db/events.js';
import { isPublicSource } from '../quoteBoard.js';

/** A page address is 32 lower-case hex characters: 128 random bits (db/events.js, newEventToken). */
export const EVENT_TOKEN_RE = /^[0-9a-f]{32}$/;

/** The path of an event's public page. */
export const eventPagePath = (token) => `/events/${token}`;

/**
 * The full link to an event's page, or null: there is no dashboard address to build it from
 * (DASHBOARD_URL is not set), or the token is not one.
 * @param {string} token
 * @param {string | null | undefined} [base]  the dashboard address, by default the configured one
 */
export function eventPageUrl(token, base = config.dashboardUrl) {
  if (!base || !EVENT_TOKEN_RE.test(token ?? '')) return null;
  return `${String(base).replace(/\/+$/, '')}${eventPagePath(token)}`;
}

/** Is the Events module on with the public pages switched on? `mod` is a getGuildModule() answer. */
export const eventPagesOn = (mod) => mod?.enabled === true && mod.config?.publicPages === true;

/**
 * Can @everyone see this event's channel, right now? It asks the same question the quote board asks
 * when it saves a quote (isPublicSource: the @everyone role can view the channel, the channel is
 * not age-restricted, a thread follows its parent and a private thread never counts), but of the
 * channel as it is at this moment, not as it was when the event was made.
 *
 * It fails closed: a channel Sylo does not have in its cache (deleted, an archived thread, a
 * platform that cannot say), a missing @everyone role, permissions that cannot be read or an error
 * all answer "not public". The page route calls this on every request, and it only reads the
 * cache, so a visitor cannot make Sylo call the platform.
 * @param {any} guild
 * @param {string} channelId
 */
export function channelIsPublic(guild, channelId) {
  try {
    const channel = channelId ? guild?.channels?.cache?.get?.(channelId) : null;
    return channel ? isPublicSource(guild, channel) === true : false;
  } catch {
    return false;
  }
}

/**
 * 'upcoming' | 'cancelled' | 'ended'. A scheduled event counts as over from its end time (or
 * END_GRACE_MS after its start when it has none) even before the one-minute tick has closed it,
 * so the page is not wrong for the half minute in between. 'upcoming' also covers an event that has
 * started and not finished.
 * @param {{ state: string, start_at: number, end_at: number | null }} ev
 */
export function eventStatus(ev, now = Date.now()) {
  if (ev.state === 'cancelled') return 'cancelled';
  if (ev.state === 'ended') return 'ended';
  const endAt = ev.end_at ?? ev.start_at + END_GRACE_MS;
  return endAt <= now ? 'ended' : 'upcoming';
}

// The hosts the page loads an event's image from. An admin may write any https link as the image
// of an event, and the posted embed shows it (Discord's own proxy fetches it). The public page is
// different: the visitor's browser would fetch it, so whoever wrote the link would learn the
// address, browser and time of every visitor. The page's Content-Security-Policy allows any https
// image (the dashboard previews admins' images), which is no reason to trust one, so the page
// shows an image only from these hosts, Discord's own image servers, where the image of an event
// uploaded to Discord lives. Anything else is left out.
const IMAGE_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/**
 * The image link if the page may show it, else null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function trustedImageUrl(value) {
  if (typeof value !== 'string' || !value || /[\s"'<>\\]/.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return IMAGE_HOSTS.has(url.hostname) ? url.href : null;
}
