// The rules behind the public page of an event (src/web/routes/events.js, and the link in the post
// in src/modules/events.js). Kept here, apart from both, so the post and the page decide the same.
//
// A page exists for an event only while all of these hold, and the page route checks every one of
// them on every request:
//   - the Events module is on and its "Public event pages" setting is a real `true`;
//   - the event's channel is one @everyone can see (channelIsPublic, which fails closed).
import { config } from '../../config.js';
import { END_GRACE_MS } from '../../db/events.js';
import { isLocalHostname } from '../../lib/localHost.js';
import { isPublicSource } from '../quoteBoard.js';

/** A page address is 32 lower-case hex characters: 128 random bits (db/events.js, newEventToken). */
export const EVENT_TOKEN_RE = /^[0-9a-f]{32}$/;

/** The path of an event's public page. */
export const eventPagePath = (token) => `/events/${token}`;

/**
 * The dashboard address as a base for links in a post, or null unless it is a public https
 * address. Discord refuses a link button to an address it cannot use (http, a local name or an IP
 * address), and a post it refuses must not cost anyone their event, so there is then no link at all.
 * @param {string | null | undefined} base
 */
export function publicLinkBase(base) {
  try {
    const url = new URL(String(base ?? ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (isLocalHostname(url.hostname.replace(/^\[|\]$/g, ''))) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The full link to an event's page, or null: there is no public https dashboard address to build
 * it from (DASHBOARD_URL is not set, or is plain http, a local name or an IP address), or the
 * token is not one.
 * @param {string} token
 * @param {string | null | undefined} [base]  the dashboard address, by default the configured one
 */
export function eventPageUrl(token, base = config.dashboardUrl) {
  const root = publicLinkBase(base);
  if (!root || !EVENT_TOKEN_RE.test(token ?? '')) return null;
  return `${root}${eventPagePath(token)}`;
}

/**
 * Did Discord refuse a message because of a link button in it? That is a validation refusal
 * (HTTP 400, code 50035, "Invalid Form Body") whose error path points at the components. The
 * discord.js error carries the status, the code and the raw body (`rawError.errors`, keyed by the
 * field that was wrong). Nothing else says the button was the problem: a timeout, a 429, a 5xx or
 * a refusal about anything else may have left a message behind or may pass at the next try, so
 * none of them is a reason to send the message again.
 * @param {any} err
 */
export function refusedLinkButton(err) {
  if (err?.status !== 400 || Number(err.code) !== 50035) return false;
  const errors = err.rawError?.errors;
  return Boolean(errors) && typeof errors === 'object' && Object.hasOwn(errors, 'components');
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

// The hosts Sylo fetches an event's image (and a Discord server's icon) from for the public page. An
// admin may write any https link as the image of an event, and the posted embed shows it (Discord's
// own proxy fetches it). The page is different: Sylo itself makes the request (modules/lib/
// eventImage.js), so it must not be made to call whatever host an admin typed. Only these hosts,
// Discord's own image servers, where the image of an event uploaded to Discord lives, are fetched.
// Anything else is left out of the page. The visitor's browser never contacts them.
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
