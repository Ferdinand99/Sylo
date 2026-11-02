// The rules behind the page of an event (src/web/routes/events.js, and the link in the post in
// src/modules/events.js). Kept here, apart from both, so the post and the page decide the same.
//
// A page exists for an event only while all of these hold, and the page route checks every one of
// them on every request:
//   - the Events module is on and its "Event pages" setting (stored as publicPages) is a real `true`;
//   - the event's channel has an audience (channelAudience): @everyone can see it ("public": anyone
//     with the link may open the page), or it is a channel only some members see ("private": only a
//     signed-in member who can see that channel, on the platform it was posted on, may open the page,
//     see viewerMaySee). A channel that is age-restricted, or that Sylo cannot see, has no page.
import { ChannelType } from 'discord.js';
import { config } from '../../config.js';
import { END_GRACE_MS } from '../../db/events.js';
import { isLocalHostname } from '../../lib/localHost.js';
import { splitPlatformGuildId } from '../../lib/platformId.js';
import { platformOfGuild } from '../../platform/platformOf.js';
import { canView, isAgeRestricted, isPublicSource } from '../quoteBoard.js';

/** A page address is 32 lower-case hex characters: 128 random bits (db/events.js, newEventToken). */
export const EVENT_TOKEN_RE = /^[0-9a-f]{32}$/;

/** The path of an event's page. */
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

/**
 * Is the Events module on with the event pages switched on? `mod` is a getGuildModule() answer. The
 * setting is stored as `publicPages` (the key it always had) and shown as "Event pages": it switches
 * on the pages of events in public channels and of events in private channels alike.
 */
export const eventPagesOn = (mod) => mod?.enabled === true && mod.config?.publicPages === true;

/** The platform a guild key belongs to: a bare id is Discord, "fluxer:<id>" is Fluxer. */
export const platformOfKey = (key) => splitPlatformGuildId(key)?.platform ?? 'discord';

/**
 * Who can open the page of an event posted in this channel, right now:
 *  - 'public': @everyone can see the channel. It asks the same question the quote board asks when it
 *    saves a quote (isPublicSource: the @everyone role can view the channel, the channel is not
 *    age-restricted, a thread follows its parent and a private thread never counts), of the channel
 *    as it is at this moment, not as it was when the event was made. No sign-in is needed.
 *  - 'private': the channel is one only some members see. Only a signed-in member who can see it
 *    may open the page (viewerMaySee decides, per visitor).
 *  - 'none': there is no page for anyone. A channel Sylo does not have in its cache (deleted, an
 *    archived thread, a platform that cannot say), a private thread, and an age-restricted channel
 *    (Sylo cannot tell whether a member has confirmed their age with the platform, so the public
 *    rule against age-restricted channels holds for members too).
 *
 * It fails closed: anything that cannot be read, and any error, answer 'none'. It only reads the
 * cache, so a visitor cannot make Sylo call the platform.
 * @param {any} guild
 * @param {string} channelId
 * @returns {'public' | 'private' | 'none'}
 */
export function channelAudience(guild, channelId) {
  try {
    const channel = channelId ? guild?.channels?.cache?.get?.(channelId) : null;
    if (!channel) return 'none';
    if (isPublicSource(guild, channel) === true) return 'public';
    if (channel.isThread?.() === true && channel.type === ChannelType.PrivateThread) return 'none';
    return isAgeRestricted(guild, channel) ? 'none' : 'private';
  } catch {
    return 'none';
  }
}

/** Can @everyone see this event's channel, right now? (channelAudience is 'public') */
export const channelIsPublic = (guild, channelId) => channelAudience(guild, channelId) === 'public';

/** How long a lookup of a member at the platform may take before the answer is no. */
export const MEMBER_LOOKUP_MS = 4000;

const defaultMembersIntent = () => config.intentGuildMembers !== false;
let membersIntent = defaultMembersIntent;
/** Tests only: replace the answer to "does the bot hold the server-members intent?". */
export function _setMembersIntent(fn) {
  membersIntent = fn ?? defaultMembersIntent;
}

/**
 * The member's data as the bot has it now. On Fluxer, and on Discord with the server-members
 * intent, the bot's member cache is kept current by the gateway (a role taken away, a member who
 * left): it is used, and a member it does not hold is fetched. On Discord without that intent the
 * cache is not kept current, so the member is always fetched fresh from the platform. A failure
 * or a slow answer rejects, and the caller reads that as "no".
 */
function liveMember(guild, userId) {
  const members = guild.members;
  const lookup = (async () => {
    if (platformOfGuild(guild) === 'fluxer' || membersIntent()) {
      return members.cache?.get?.(userId) ?? (await members.fetch(userId));
    }
    return members.fetch({ user: userId, force: true });
  })();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('member lookup timed out')), MEMBER_LOOKUP_MS);
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

/**
 * May this person open the page of an event in this channel? They must be a member of the server on
 * the guild's own platform, and the platform's permission rules must let them see the channel (a
 * thread follows its parent), by the bot's live data of that moment. Nothing is remembered between
 * requests: a person who loses a role or leaves the server is refused at the next request.
 *
 * It fails closed. Everything that is not a clear yes is a no: a member that cannot be found or read,
 * a member object that is not that person, a channel Sylo does not have, a private thread, an
 * age-restricted channel, permissions that cannot be read, a slow answer, an error.
 * @param {any} guild
 * @param {string} channelId
 * @param {string | null | undefined} userId  the person's id on the guild's platform
 */
export async function viewerMaySee(guild, channelId, userId) {
  try {
    if (!guild || !channelId || !userId || typeof userId !== 'string') return false;
    if (channelAudience(guild, channelId) === 'none') return false;
    const channel = guild.channels.cache.get(channelId);
    const member = await liveMember(guild, userId);
    if (!member || String(member.id ?? member.user?.id) !== userId) return false;
    return (await canView(channel, member)) === true;
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
