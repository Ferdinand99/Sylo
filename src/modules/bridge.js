// Bridge: one conversation between a Discord channel and a Fluxer channel.
//
// A link joins two channels, one on each platform. It starts with a request from one server (a one-time
// code that expires in 15 minutes) and is accepted, with that code, by someone with Edit access in the
// other server. Both servers therefore agreed, Sylo must be in both, and either can unlink at any time.
// Each side has its own options (what leaves THAT server), so neither can make the other share more.
//
// What crosses, through a webhook Sylo makes in each channel: messages (with the author's name and picture),
// replies (a quote of the original), files (re-uploaded within limits, otherwise a link), custom emoji with the
// same name, stickers, rich embeds, polls (as text) and, if a server turns it on, join messages. Edits and
// deletes follow through the message map (db/bridge.js), which keeps a message 30 days.
//
// Safety, in the order a message meets it:
//   - no loop: a message sent by any Sylo bridge webhook, or by Sylo itself, is never relayed again, and a
//     channel is in at most one link, so a copy cannot come back
//   - no ping: every copy is sent with allowedMentions none, and the text has its mentions turned into names
//   - bots are off by default (per side), and a message that is not a plain chat message is never relayed
//   - an age-restricted channel is only ever linked to an age-restricted channel, checked at link time and again
//     on every message (a change pauses the link)
//   - the webhook is rate limited: one queue per webhook, spaced sends, back-off on 429, a cap on the queue
//   - a link that fails (no permission, webhook cannot be remade, delivery fails five times in a row) is
//     stopped, shown as a problem in Health, and announced in both channels; it is not retried forever
//   - each server is isolated: queues, links and failures are per link, never shared between servers
import { ChannelType } from 'discord.js';
import { on } from './dispatch.js';
import { every } from './schedule.js';
import { getGuildModule, isModuleEnabled, setGuildModule } from '../db/modules.js';
import { recordAudit } from '../db/audit.js';
import { onBeforePurge } from '../db/purge.js';
import { PAIR_RUNNING, getPair as getMirrorPair, mirrorPairOfLink } from '../db/mirror.js';
import * as store from '../db/bridge.js';
import { runtime } from '../runtime.js';
import { splitPlatformGuildId } from '../lib/platformId.js';
import { guildByKey } from '../platform/platformOf.js';
import { createWebhookTransport } from '../platform/webhooks.js';
import { isAgeRestricted as ageOf, jumpUrl } from './quoteBoard.js';
import { safeFetch } from '../lib/safeFetch.js';
import { log } from '../lib/log.js';
import { config } from '../config.js';
import { sweepMap } from '../lib/sweepMap.js';
import { BridgeQueueError, classifyError, createRelayQueue, relayGapMs } from './lib/bridgeQueue.js';
import {
  FILE_BYTES_LIMIT,
  escapeMarkdown,
  fileLinkLines,
  hashContent,
  ZWSP,
  inertAt,
  joinParts,
  mapEmoji,
  neutraliseMentions,
  normaliseOptions,
  pollText,
  planAttachments,
  plainEmbeds,
  plainTimestamps,
  replyHead,
  senderName,
  stickerLines,
} from './lib/bridgeText.js';

// The module has no settings of its own (modules/limits.js lists none); these are its ceilings, sent to the
// page with the overview.
/**
 * The most links a server can have, by hand and through a server mirror alike (src/mirror/bridgeLink.js links
 * every copied text channel). The operator sets it with BRIDGE_MAX_LINKS (default 100, 1 to 500, see
 * src/lib/bridgeLimit.js); tests replace it through useBridgeParts.
 */
let maxLinks = config.bridgeMaxLinks;
export const getMaxLinks = () => maxLinks;
/** The most requests a server can have waiting. */
export const MAX_REQUESTS = 5;
/** The refusal for a server that is at the ceiling (the operator raises it with BRIDGE_MAX_LINKS). */
const limitError = (code = '') =>
  new BridgeError(
    `This server has reached its limit of ${maxLinks} bridged channels. The operator of this Sylo instance can raise it with BRIDGE_MAX_LINKS.`,
    409,
    code
  );

/** How many failed deliveries in a row stop a link. */
export const FAIL_THRESHOLD = 5;
const HOOK_NAME = 'Sylo bridge';
const CACHE_MS = 60_000;

/** A refusal the dashboard shows as it is. `status` is the HTTP answer. */
export class BridgeError extends Error {
  /** `code` names the refusal for code that has to tell them apart (the server mirror's report). */
  constructor(message, status = 400, code = '') {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
  }
}

// --- wiring that tests replace -----------------------------------------------------------------------

let transport = createWebhookTransport();
let queue = createRelayQueue({ platformGaps: true });
let download = (url, maxBytes) => safeFetch(url, { maxBytes, timeoutMs: 15_000 });

// One budget for every file download of the process, across all servers: files are held in memory until
// they are sent, so a few busy bridges must not add up to hundreds of megabytes. A file that does not fit in
// the budget crosses as a link instead of waiting for room.
const DEFAULT_BUDGET = Object.freeze({ concurrent: 4, bytes: 32 * 1024 * 1024 });
let budget = { ...DEFAULT_BUDGET };
const inUse = { concurrent: 0, bytes: 0 };
function reserveDownload(size) {
  if (inUse.concurrent >= budget.concurrent || inUse.bytes + size > budget.bytes) return false;
  inUse.concurrent += 1;
  inUse.bytes += size;
  return true;
}
function releaseDownload(size) {
  inUse.concurrent -= 1;
  inUse.bytes -= size;
}

/** Use other parts (tests): a transport, a queue, a downloader, a download budget. No arguments: the real ones. */
export function useBridgeParts({ transport: t, queue: q, download: d, budget: b, maxLinks: m } = {}) {
  maxLinks = m ?? config.bridgeMaxLinks;
  transport = t ?? createWebhookTransport();
  queue = q ?? createRelayQueue({ platformGaps: true });
  download = d ?? ((url, maxBytes) => safeFetch(url, { maxBytes, timeoutMs: 15_000 }));
  budget = { ...DEFAULT_BUDGET, ...b };
}

// Relays that are still on their way, so a test (and a shutdown) can wait for them.
const inFlight = new Set();
const track = (promise) => {
  inFlight.add(promise);
  promise.finally(() => inFlight.delete(promise)).catch(() => {});
  return promise;
};
/** Resolves when every relay started so far has been delivered or given up. */
export const bridgeIdle = async () => {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
};

// --- small helpers -----------------------------------------------------------------------------------

const other = (side) => (side === 'a' ? 'b' : 'a');
const guildOf = (link, side) => (side === 'a' ? link.guildA : link.guildB);
const channelOf = (link, side) => (side === 'a' ? link.channelA : link.channelB);
const optionsOf = (link, side) => normaliseOptions(side === 'a' ? link.optionsA : link.optionsB);
const hookOf = (link, side) =>
  side === 'a'
    ? { id: link.hookAId, token: link.hookAToken, channelId: link.channelA }
    : { id: link.hookBId, token: link.hookBToken, channelId: link.channelB };
const sideOf = (link, key) => (link.guildA === key ? 'a' : link.guildB === key ? 'b' : null);
const platformOf = (key) => splitPlatformGuildId(key)?.platform ?? 'discord';
const laneKey = (link, side) => `${link.id}|${side}`;
/** The pause the platform that owns the webhook on `side` needs between two calls (see relayGapMs). */
const gapOf = (link, side, op) => relayGapMs(platformOf(guildOf(link, side)), op);
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

const channelIn = (key, channelId) => guildByKey(key)?.channels?.cache?.get?.(channelId) ?? null;
const isTextChannel = (channel) => Boolean(channel) && TEXT_TYPES.has(channel.type);
/**
 * Is this channel age-restricted, the way the platform decides it? On Fluxer that is the channel's own
 * setting, else its category's, else the server's (and what cannot be read counts as restricted:
 * quoteBoard.js, fluxerAgeRestricted). A Discord server that is itself marked age-restricted counts for
 * every channel in it.
 */
function ageRestricted(key, channel) {
  const guild = guildByKey(key);
  if (platformOf(key) === 'discord' && guild?.nsfwLevel === 3) return true;
  return ageOf(guild, channel);
}

// Names of servers and channels in Sylo's own notices: no markdown, so a name cannot make a link.
const serverLabel = (key) => escapeMarkdown(inertAt(guildByKey(key)?.name ?? 'another server'));
const channelLabel = (key, channelId) => escapeMarkdown(channelIn(key, channelId)?.name ?? 'a channel');

// Messages that were deleted: a delete can win the race against the relay of the same message (moderation
// runs right after the relay starts), so the relay asks before it posts and again after.
const deletedSoon = new Map();
const TOMBSTONE_MS = 2 * 60_000;
const markDeleted = (key, messageId) => {
  if (deletedSoon.size > 20_000) deletedSoon.clear();
  deletedSoon.set(`${key}|${messageId}`, Date.now());
};
const wasDeleted = (key, messageId) =>
  Date.now() - (deletedSoon.get(`${key}|${messageId}`) ?? 0) < TOMBSTONE_MS;
sweepMap(deletedSoon, (at, now) => now - at > TOMBSTONE_MS);

// The bridge is for the owners of the two servers only (the routes check who is calling). The owner of each
// server is recorded when the link is made and when a new owner confirms it; if the platform reports another
// owner later, the link pauses until that owner presses Resume.
const ownerOf = (key) => String(guildByKey(key)?.ownerId ?? '');

/** The side whose server has another owner than the one recorded, or null. An unknown owner is not a change. */
function ownerChangedSide(link) {
  for (const s of ['a', 'b']) {
    const recorded = s === 'a' ? link.ownerA : link.ownerB;
    const now = ownerOf(guildOf(link, s));
    if (recorded && now && recorded !== now) return s;
  }
  return null;
}

/** Pause a running link because the owner of `side`'s server changed, and say so on both sides. */
async function pauseForOwner(link, side) {
  if (link.status !== 'active') return;
  await store.setLinkStatus(link.id, { status: 'paused', pausedSide: side, reason: 'owner-changed' });
  dropBridgeCache();
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  log.info('bridge', `link ${link.id} paused: the owner of a server changed`);
  for (const s of ['a', 'b']) {
    await recordAudit(guildOf(link, s), {
      actor: 'Sylo',
      action: 'bridge:pause',
      detail:
        `the bridge of #${channelName(guildOf(link, s), channelOf(link, s))} paused: the owner of ${serverName(guildOf(link, side))} changed`.slice(
          0,
          500
        ),
      change: null,
    });
    await say(
      guildOf(link, s),
      channelOf(link, s),
      `🌉 **Bridge paused:** the owner of ${serverLabel(guildOf(link, side))} changed. Nothing is shared until the new owner confirms it.`
    );
  }
}

/** Cached lookups of "which link is this channel in", dropped whenever a link changes. */
const cache = new Map();
export const dropBridgeCache = () => cache.clear();
async function findLink(key, channelId) {
  const id = `${key}|${channelId}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await store.linkForChannel(key, channelId);
  if (cache.size > 5000) cache.clear();
  cache.set(id, { at: Date.now(), value });
  return value;
}

/** Say something in a channel (the visible notices). Best effort: a channel Sylo cannot write in is skipped. */
async function say(key, channelId, content) {
  try {
    await channelIn(key, channelId)?.send?.({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    log.debug('bridge', `could not post a notice in ${channelId}: ${err?.message ?? err}`);
  }
}

const platformName = (key) => (platformOf(key) === 'fluxer' ? 'Fluxer' : 'Discord');
const serverName = (key) => inertAt(guildByKey(key)?.name ?? 'another server');
const channelName = (key, channelId) => channelIn(key, channelId)?.name ?? 'a channel';

/** The notice both channels show while a bridge is on. */
const onNotice = (mineKey, theirKey, theirChannelId) =>
  `🌉 **Bridge on.** Messages in this channel are shared with #${channelLabel(theirKey, theirChannelId)} in ` +
  `**${serverLabel(theirKey)}** on ${platformName(theirKey)}, and theirs appear here. Nobody is pinged across ` +
  `the bridge. Server admins can pause or unlink it at any time in the Sylo dashboard.`;

const REASONS = {
  permissions:
    'Sylo is missing a permission it needs here (Manage Webhooks, or to send in the channel). Fix the permission, then resume the bridge in the dashboard.',
  webhook: 'Sylo could not make a new webhook after the old one was deleted.',
  unreachable: 'Messages could not be delivered several times in a row.',
  'channel-deleted': 'A bridged channel was deleted.',
  'channel-missing': 'Sylo cannot see one of the bridged channels.',
  'owner-changed':
    'The owner of one of the servers changed. The bridge is paused until the new owner confirms it: as the owner, open the Bridge page and press Resume.',
  'age-restriction':
    'One channel changed its age restriction, so the two no longer match. An age-restricted channel can only be bridged with an age-restricted one.',
  mirror:
    'This bridge was made by the server mirror and is paused with it. It runs again when the mirror does.',
  'mirror-ended':
    'The server mirror that made this bridge was removed, and the bridge was paused. Only the server that removed the mirror can resume it; either server can unlink it.',
  visibility:
    'The two channels are no longer open to the same people (one became private). A channel everyone can read is never bridged to a private one.',
};
/** The text a link's stored failure reason stands for. */
export const reasonText = (code) => REASONS[code] ?? 'The bridge stopped working.';

// --- the pieces of a link, looked up on the platforms ------------------------------------------------

/** Does `perms` lack `name`? No answer at all counts as lacking; a permission name the platform does not know does not. */
function lacks(perms, name) {
  if (!perms || typeof perms.has !== 'function') return true;
  try {
    return perms.has(name) !== true;
  } catch {
    return false;
  }
}

/**
 * The person linking must be able to view, read and send in the channel themselves: Sylo does not let
 * anyone make it do what they could not do (the bridge would carry a hidden channel to a server they run).
 * `member` is their member in this server. Open mode (no logins) passes `open: true`.
 */
export function assertActorMayUse(key, channelId, member, { open = false } = {}) {
  if (open) return;
  const channel = channelIn(key, channelId);
  const perms = member && channel?.permissionsFor?.(member);
  const missing = ['ViewChannel', 'ReadMessageHistory', 'SendMessages'].filter((p) => lacks(perms, p));
  if (!perms || missing.length) {
    throw new BridgeError(
      `You need to be able to view, read and send in #${channel?.name ?? 'that channel'} yourself to bridge it.`,
      403,
      'visibility'
    );
  }
}

/**
 * Check a channel of a server can be bridged: Sylo sees it, it is a normal text channel, and Sylo may
 * view it, send in it and manage webhooks there.
 * @returns {{ guild: any, channel: any }}
 */
function checkChannel(key, channelId) {
  const guild = guildByKey(key);
  if (!guild) throw new BridgeError('Sylo is not in that server.', 404, 'no-guild');
  const channel = guild.channels?.cache?.get?.(channelId);
  if (!isTextChannel(channel)) {
    throw new BridgeError('Pick a normal text channel of this server.', 400, 'not-text');
  }
  const perms = channel.permissionsFor?.(guild.members?.me);
  // Sylo's own rights: when they cannot be read, they count as missing.
  const missing = ['ViewChannel', 'SendMessages', 'ManageWebhooks'].filter((p) => lacks(perms, p));
  if (missing.length) {
    throw new BridgeError(
      `Sylo needs ${missing.join(', ')} in #${channel.name}. Give Sylo's role those permissions there first.`,
      400,
      'permissions'
    );
  }
  return { guild, channel };
}

async function requireModule(key) {
  if (!(await isModuleEnabled(key, 'bridge'))) {
    throw new BridgeError('Turn the Bridge module on for this server first.', 409);
  }
}

function requireBothPlatforms() {
  if (!runtime.clients.discord || !runtime.clients.fluxer) {
    throw new BridgeError(
      'A bridge needs this Sylo to be connected to both Discord and Fluxer, and it is not.',
      409,
      'platform'
    );
  }
}

/** The age rule: an age-restricted channel only with an age-restricted channel. */
function checkAge(keyA, a, keyB, b) {
  if (ageRestricted(keyA, a) !== ageRestricted(keyB, b)) {
    throw new BridgeError(
      'An age-restricted channel can only be bridged with another age-restricted channel.',
      400,
      'age-restriction'
    );
  }
}

// --- linking: request, accept ------------------------------------------------------------------------

/**
 * Ask for a link from one of this server's channels. Returns the one-time code to give the other server.
 * @param {{ guildKey: string, channelId: string, options?: object, actor: string }} req
 */
export async function requestLink({ guildKey, channelId, options, actor }) {
  requireBothPlatforms();
  await requireModule(guildKey);
  checkChannel(guildKey, channelId);
  if (await store.linkForChannel(guildKey, channelId))
    throw new BridgeError('That channel is already bridged.', 409);
  if (await store.channelHasPendingCode(guildKey, channelId)) {
    throw new BridgeError('That channel already has a request waiting. Cancel it to make a new one.', 409);
  }
  if ((await store.linkCount(guildKey)) >= maxLinks) throw limitError('limit');
  if ((await store.pendingCodeCount(guildKey)) >= MAX_REQUESTS) {
    throw new BridgeError(`At most ${MAX_REQUESTS} requests can wait at once. Cancel one first.`, 409);
  }
  const made = await store.createCode({
    guildId: guildKey,
    channelId,
    options: normaliseOptions(options),
    requestedBy: actor,
    guildOwner: ownerOf(guildKey),
  });
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:request',
    detail: `asked to bridge #${channelName(guildKey, channelId)} (valid 15 minutes)`,
    change: null,
  });
  return made;
}

export async function cancelRequest({ guildKey, id, actor }) {
  if (!(await store.cancelCode(guildKey, id))) throw new BridgeError('That request is gone already.', 404);
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:cancel',
    detail: 'cancelled a bridge request',
    change: null,
  });
}

const INVALID_CODE = 'That code is not valid, has expired or was already used.';

/**
 * Accept a request with its code, linking one of THIS server's channels to the channel the code was made for.
 * Everything that can be refused is checked before the code is used up, so a wrong channel does not burn it.
 * @param {{ guildKey: string, channelId: string, code: string, options?: object, actor: string }} req
 */
export async function acceptLink({ guildKey, channelId, code, options, actor }) {
  requireBothPlatforms();
  await requireModule(guildKey);
  const mine = checkChannel(guildKey, channelId);
  if (await store.linkForChannel(guildKey, channelId))
    throw new BridgeError('That channel is already bridged.', 409);
  if ((await store.linkCount(guildKey)) >= maxLinks) throw limitError('limit');

  const request = await store.peekCode(code);
  if (!request) throw new BridgeError(INVALID_CODE, 404);
  if (request.guildId === guildKey) throw new BridgeError('That request was made in this server.', 409);
  const ownerA = ownerOf(request.guildId);
  if (request.guildOwner && ownerA && request.guildOwner !== ownerA) {
    throw new BridgeError('The server that made this request has a new owner. Ask for a new code.', 409);
  }
  if (platformOf(request.guildId) === platformOf(guildKey)) {
    throw new BridgeError(
      'A bridge joins a Discord channel to a Fluxer channel, not two on the same platform.'
    );
  }
  // The other server must still have Sylo, with the module on and the channel as it was asked for.
  if (!(await isModuleEnabled(request.guildId, 'bridge'))) {
    throw new BridgeError('The server that made this request turned its Bridge module off.', 409);
  }
  let theirs;
  try {
    theirs = checkChannel(request.guildId, request.channelId);
  } catch (err) {
    if (err instanceof BridgeError) {
      throw new BridgeError(`The other server's channel can no longer be bridged: ${err.message}`, 409);
    }
    throw err;
  }
  if (await store.linkForChannel(request.guildId, request.channelId)) {
    throw new BridgeError('The other channel was bridged in the meantime.', 409);
  }
  // The server that asked may have filled its limit since it made the request.
  if ((await store.linkCount(request.guildId)) >= maxLinks) {
    throw new BridgeError(
      "The server that made this request has reached its limit of bridged channels, so it cannot take another. Ask the operator of this Sylo instance to raise BRIDGE_MAX_LINKS, or unlink a channel there.",
      409,
      'limit'
    );
  }
  checkAge(guildKey, mine.channel, request.guildId, theirs.channel);

  // A webhook in each channel, made before the code is claimed (the claim is the atomic step: if two servers
  // race, one loses and its webhooks are removed again).
  const made = [];
  const dropMade = async () => {
    for (const [key, hook] of made) await transport.deleteHook(key, hook).catch(() => {});
  };
  let hookA;
  let hookB;
  try {
    hookA = await transport.createHook(request.guildId, request.channelId, HOOK_NAME);
    made.push([request.guildId, hookA]);
    hookB = await transport.createHook(guildKey, channelId, HOOK_NAME);
    made.push([guildKey, hookB]);
  } catch (err) {
    await dropMade();
    log.warn('bridge', `could not make the webhooks for a link: ${err?.message ?? err}`);
    throw new BridgeError(
      'Sylo could not make a webhook in one of the channels. Check that it has Manage Webhooks in both.',
      502
    );
  }

  const claimed = await store.claimCode(code);
  if (!claimed) {
    await dropMade();
    throw new BridgeError(INVALID_CODE, 404);
  }
  const id = await store.createLink({
    guildA: request.guildId,
    channelA: request.channelId,
    guildB: guildKey,
    channelB: channelId,
    optionsA: normaliseOptions(claimed.options),
    optionsB: normaliseOptions(options),
    hookA,
    hookB,
    requestedBy: claimed.requestedBy,
    acceptedBy: actor,
    ownerA,
    ownerB: ownerOf(guildKey),
  });
  if (!id) {
    await dropMade();
    throw new BridgeError('One of the channels was bridged in the meantime.', 409);
  }
  dropBridgeCache();
  const link = await store.getLink(id);
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:link',
    detail: `bridged #${channelName(guildKey, channelId)} with #${channelName(request.guildId, request.channelId)} in ${serverName(request.guildId)} (${platformName(request.guildId)})`,
    change: null,
  });
  await recordAudit(request.guildId, {
    actor: claimed.requestedBy ? `${claimed.requestedBy}` : 'Dashboard',
    action: 'bridge:link',
    detail: `bridged #${channelName(request.guildId, request.channelId)} with #${channelName(guildKey, channelId)} in ${serverName(guildKey)} (${platformName(guildKey)}); accepted there`,
    change: null,
  });
  await say(guildKey, channelId, onNotice(guildKey, request.guildId, request.channelId));
  await say(request.guildId, request.channelId, onNotice(request.guildId, guildKey, channelId));
  return link;
}

// --- link lifecycle: options, pause, resume, unlink --------------------------------------------------

/** A link of this server (either side), or a 404: a server never sees or changes another server's links. */
async function ownLink(guildKey, id) {
  const link = await store.getLink(id);
  const side = link && sideOf(link, guildKey);
  if (!link || !side) throw new BridgeError('No such bridged channel in this server.', 404);
  return { link, side };
}

export async function setSideOptions({ guildKey, id, options, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  const next = normaliseOptions({ ...optionsOf(link, side), ...options });
  await store.setLinkOptions(link.id, side, next);
  dropBridgeCache();
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:options',
    detail: `changed what #${channelName(guildKey, channelOf(link, side))} shares (bots ${next.bots ? 'on' : 'off'}, joins ${next.joinMessages ? 'on' : 'off'}, files ${next.uploadFiles ? 'uploaded' : 'as links'})`,
    change: null,
  });
  return next;
}

export async function pauseLink({ guildKey, id, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  if (link.status !== 'active') throw new BridgeError('That bridge is not running.', 409);
  await store.setLinkStatus(link.id, { status: 'paused', pausedSide: side });
  dropBridgeCache();
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:pause',
    detail: `paused #${channelName(guildKey, channelOf(link, side))}`,
    change: null,
  });
  const theirKey = guildOf(link, other(side));
  await say(
    guildOf(link, side),
    channelOf(link, side),
    '🌉 **Bridge paused** by this server. Nothing is shared until it is resumed.'
  );
  await say(
    theirKey,
    channelOf(link, other(side)),
    `🌉 **Bridge paused** by ${serverLabel(guildKey)}. Nothing is shared until they resume it.`
  );
}

/**
 * Everything that has to hold before a stopped or paused link runs again: both platforms connected, the module on
 * on both servers, both channels usable by Sylo, the age rule, and a working webhook on each side.
 */
async function revalidate(link) {
  requireBothPlatforms();
  await requireModule(link.guildA);
  await requireModule(link.guildB);
  const a = checkChannel(link.guildA, link.channelA);
  const b = checkChannel(link.guildB, link.channelB);
  checkAge(link.guildA, a.channel, link.guildB, b.channel);
  for (const s of ['a', 'b']) {
    const key = guildOf(link, s);
    const hook = hookOf(link, s);
    if (!hook.id || !hook.token) {
      await remakeHook(link, s);
    } else {
      try {
        // A webhook can be deleted while the link is stopped; the first message would then fail. Make a new one now.
        const probe = channelIn(key, channelOf(link, s))?.fetchWebhooks;
        if (probe) {
          const list = await channelIn(key, channelOf(link, s)).fetchWebhooks();
          const alive = [...(list?.values?.() ?? list ?? [])].some((h) => String(h.id) === hook.id);
          if (!alive) await remakeHook(link, s);
        }
      } catch (err) {
        log.debug('bridge', `could not check the webhook of link ${link.id}: ${err?.message ?? err}`);
      }
    }
  }
  failures.delete(link.id);
}

/**
 * Resume a link. A link a server paused can only be resumed by that server; one Sylo stopped (a failure)
 * can be resumed by either, after the cause is fixed: the channels, permissions, webhooks and the age rule
 * are checked again first.
 */
export async function resumeLink({ guildKey, id, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  if (link.status === 'active') throw new BridgeError('That bridge is already running.', 409);
  if ((await mirrorHold(link)) === 'held') {
    throw new BridgeError(
      'The server mirror made this bridge and holds it while the mirror is not running. It runs again when the mirror does.',
      409
    );
  }
  // A link nobody owns the pause of (its mirror was removed by nobody in particular) can be resumed by either server.
  if (link.status === 'paused' && link.pausedSide && link.pausedSide !== side) {
    throw new BridgeError('The other server paused this bridge, so only they can resume it.', 403);
  }
  // The one pressing Resume is the owner of this server (the route checks): this is the confirmation a new owner gives.
  await store.setLinkOwner(link.id, side, ownerOf(guildKey));
  link[side === 'a' ? 'ownerA' : 'ownerB'] = ownerOf(guildKey);
  await revalidate(link);
  // The other server's owner may have changed too: it has to confirm as well before anything is shared.
  const stillChanged = ownerChangedSide(link);
  if (stillChanged) {
    await store.setLinkStatus(link.id, {
      status: 'paused',
      pausedSide: stillChanged,
      reason: 'owner-changed',
    });
    dropBridgeCache();
    await recordAudit(guildKey, {
      actor,
      action: 'bridge:resume',
      detail: `confirmed #${channelName(guildKey, channelOf(link, side))}; waiting for the other server's new owner`,
      change: null,
    });
    return { active: false };
  }
  await store.setLinkStatus(link.id, { status: 'active' });
  dropBridgeCache();
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:resume',
    detail: `resumed #${channelName(guildKey, channelOf(link, side))}`,
    change: null,
  });
  await say(link.guildA, link.channelA, onNotice(link.guildA, link.guildB, link.channelB));
  await say(link.guildB, link.channelB, onNotice(link.guildB, link.guildA, link.channelA));
  return { active: true };
}

// --- links made by the server mirror ------------------------------------------------------------------
//
// The server mirror (src/mirror/) copies a Discord server's channels onto a Fluxer server and then links each
// pair of text channels through the bridge, so one conversation runs through both. Both server owners agreed
// to the mirror, which is the consent a link code carries for a link made by hand, so these links are made
// without a code. Everything else of the bridge holds for them: the age rule, the visibility rules, Sylo's and
// the owners' own rights in the channels, a visible notice in both channels, bots off by default, the owners
// recorded for the ownership check, and either owner can unlink a channel at any time. A link the mirror made
// is held with the mirror: while the mirror is paused or stopped, its links are paused (reason `mirror`), and
// they run again when the mirror does.

/** What a mirror-made link records as the people who agreed to it. */
const mirrorBy = (name) => `${String(name || 'server owner').slice(0, 60)} (server mirror)`.slice(0, 100);

/** Can @everyone see this channel? null when that cannot be worked out (it then counts as not matching). */
function everyoneSees(key, channel) {
  const guild = guildByKey(key);
  try {
    // eslint-disable-next-line no-restricted-syntax -- the @everyone role id is the platform guild id
    const perms = channel?.permissionsFor?.(String(guild?.id ?? ''));
    if (!perms || typeof perms.has !== 'function') return null;
    return perms.has('ViewChannel') === true;
  } catch {
    return null;
  }
}

/** Are the two channels equally open: both visible to @everyone or both not? Unknown counts as different. */
function samePrivacy(keyA, channelA, keyB, channelB) {
  const a = everyoneSees(keyA, channelA);
  const b = everyoneSees(keyB, channelB);
  return a !== null && b !== null && a === b;
}

/** A link the server mirror made records its two owners as "<name> (server mirror)". */
const MIRROR_TAG = '(server mirror)';
const madeByMirror = (link) => String(link?.requestedBy ?? '').endsWith(MIRROR_TAG);

/**
 * Who holds a link: 'held' while its server mirror is not running (or the link is paused by it), 'ended' when it
 * says the mirror holds it but that mirror is gone (the pair was replaced), otherwise 'none'. A held link cannot
 * be resumed on the Bridge page: it comes back with the mirror.
 */
export async function mirrorHold(link) {
  const pairId = await mirrorPairOfLink(link.id);
  if (!pairId) return link.status === 'paused' && link.failReason === 'mirror' ? 'ended' : 'none';
  const pair = await getMirrorPair(pairId);
  if (!pair) return link.status === 'paused' && link.failReason === 'mirror' ? 'ended' : 'none';
  if (!PAIR_RUNNING.includes(pair.status)) return 'held';
  return link.status === 'paused' && link.failReason === 'mirror' ? 'held' : 'none';
}

/**
 * Turn the Bridge module on in a server the mirror links channels in. The owner agreed to the mirror, which
 * links every copied channel, and the module has to be on for the links to carry anything.
 * @returns {Promise<boolean>} whether it was switched on now
 */
export async function enableBridgeForMirror(key, actor = 'Server mirror') {
  if (await isModuleEnabled(key, 'bridge')) return false;
  await setGuildModule(key, 'bridge', { enabled: true });
  await recordAudit(key, {
    actor,
    action: 'bridge:module',
    detail: 'turned the Bridge module on because the server mirror links the channels of this server',
    change: null,
  });
  return true;
}

/**
 * Link a mirrored channel pair (the Discord channel is side a, the Fluxer copy side b). Throws a BridgeError
 * with a `code` when the pair cannot be linked (`not-text`, `permissions`, `age-restriction`, `visibility`,
 * `exists`, `limit`, `webhook`, `no-guild`, `platform`); the caller reports it and goes on with the next pair.
 * `members` are the two owners' members in their own servers, to check that each can see, read and send in
 * the channel; `open` says sign-in is off, so there is no one to check.
 * @param {{
 *   source: { guildKey: string, channelId: string }, target: { guildKey: string, channelId: string },
 *   members?: { source?: any, target?: any }, open?: boolean,
 *   consent?: { sourceBy?: string, targetBy?: string, sourceOwner?: string, targetOwner?: string }
 * }} req
 */
export async function createMirrorLink({ source, target, members = {}, open = false, consent = {} }) {
  requireBothPlatforms();
  const a = checkChannel(source.guildKey, source.channelId);
  const b = checkChannel(target.guildKey, target.channelId);
  if (
    (await store.linkForChannel(source.guildKey, source.channelId)) ||
    (await store.linkForChannel(target.guildKey, target.channelId))
  ) {
    throw new BridgeError('One of the channels is already bridged.', 409, 'exists');
  }
  for (const key of [source.guildKey, target.guildKey]) {
    if ((await store.linkCount(key)) >= maxLinks) throw limitError('limit');
  }
  checkAge(source.guildKey, a.channel, target.guildKey, b.channel);
  // A channel only some members can see is linked only to a channel that is as closed: nothing private is
  // shared with a channel everyone can read, in either direction.
  if (!samePrivacy(source.guildKey, a.channel, target.guildKey, b.channel)) {
    throw new BridgeError(
      'The two channels are not open to the same people (one is private, or it cannot be told), so they are not bridged.',
      409,
      'visibility'
    );
  }
  assertActorMayUse(source.guildKey, source.channelId, members.source, { open });
  assertActorMayUse(target.guildKey, target.channelId, members.target, { open });

  const made = [];
  const dropMade = async () => {
    for (const [key, hook] of made) await transport.deleteHook(key, hook).catch(() => {});
  };
  let hookA;
  let hookB;
  try {
    hookA = await transport.createHook(source.guildKey, source.channelId, HOOK_NAME);
    made.push([source.guildKey, hookA]);
    hookB = await transport.createHook(target.guildKey, target.channelId, HOOK_NAME);
    made.push([target.guildKey, hookB]);
  } catch (err) {
    await dropMade();
    log.warn('bridge', `could not make the webhooks for a mirrored link: ${err?.message ?? err}`);
    throw new BridgeError('Sylo could not make a webhook in one of the channels.', 502, 'webhook');
  }
  const id = await store.createLink({
    guildA: source.guildKey,
    channelA: source.channelId,
    guildB: target.guildKey,
    channelB: target.channelId,
    optionsA: normaliseOptions({}),
    optionsB: normaliseOptions({}),
    hookA,
    hookB,
    requestedBy: mirrorBy(consent.sourceBy),
    acceptedBy: mirrorBy(consent.targetBy),
    ownerA: consent.sourceOwner || ownerOf(source.guildKey),
    ownerB: consent.targetOwner || ownerOf(target.guildKey),
  });
  if (!id) {
    await dropMade();
    throw new BridgeError('One of the channels was bridged in the meantime.', 409, 'exists');
  }
  dropBridgeCache();
  const link = await store.getLink(id);
  for (const [mine, theirs, by] of [
    [source, target, consent.sourceBy],
    [target, source, consent.targetBy],
  ]) {
    await recordAudit(mine.guildKey, {
      actor: by || 'Server mirror',
      action: 'bridge:link',
      detail: `bridged #${channelName(mine.guildKey, mine.channelId)} with #${channelName(theirs.guildKey, theirs.channelId)} in ${serverName(theirs.guildKey)} (${platformName(theirs.guildKey)}) through the server mirror`,
      change: null,
    });
  }
  const note = ' This link was made by the server mirror that both servers’ owners agreed to.';
  await say(
    source.guildKey,
    source.channelId,
    onNotice(source.guildKey, target.guildKey, target.channelId) + note
  );
  await say(
    target.guildKey,
    target.channelId,
    onNotice(target.guildKey, source.guildKey, source.channelId) + note
  );
  return link;
}

/** Pause a running link because its mirror is not running. No notice per channel: nothing is shared while it is paused. */
export async function holdMirrorLink(linkId) {
  const link = await store.getLink(linkId);
  if (!link || link.status !== 'active') return false;
  await store.setLinkStatus(link.id, { status: 'paused', pausedSide: '', reason: 'mirror' });
  dropBridgeCache();
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  return true;
}

/**
 * Run a link again that is paused with its mirror. The checks of a resume are made again (channels, rights, age
 * rule, webhooks), and a server that changed hands since keeps the link paused until its new owner confirms.
 * @returns {Promise<{ resumed: boolean, reason?: string }>}
 */
export async function resumeMirrorLink(linkId) {
  const link = await store.getLink(linkId);
  if (!link || link.status !== 'paused' || link.failReason !== 'mirror') return { resumed: false };
  try {
    await revalidate(link);
  } catch (err) {
    if (err instanceof BridgeError) return { resumed: false, reason: err.message };
    throw err;
  }
  // The channels must still be equally open: a channel can have turned private since the link was made.
  if (
    !samePrivacy(
      link.guildA,
      channelIn(link.guildA, link.channelA),
      link.guildB,
      channelIn(link.guildB, link.channelB)
    )
  ) {
    return { resumed: false, reason: reasonText('visibility') };
  }
  const changed = ownerChangedSide(link);
  if (changed) {
    await store.setLinkStatus(link.id, { status: 'paused', pausedSide: changed, reason: 'owner-changed' });
    dropBridgeCache();
    return { resumed: false, reason: 'owner-changed' };
  }
  await store.setLinkStatus(link.id, { status: 'active' });
  dropBridgeCache();
  return { resumed: true };
}

/**
 * The mirror that made a link was removed by `side` ('a' the Discord server, 'b' the Fluxer server): the link stays,
 * paused by that server, so only its owner can resume it and the other server's owner can unlink it. Without a side
 * (a removal nobody owns) either owner can resume it.
 */
export async function releaseMirrorLink(linkId, side = '') {
  const link = await store.getLink(linkId);
  if (!link) return false;
  const mine = link.status === 'active' || (link.status === 'paused' && link.failReason === 'mirror');
  if (!mine) return false;
  await store.setLinkStatus(link.id, {
    status: 'paused',
    pausedSide: side === 'a' || side === 'b' ? side : '',
    reason: 'mirror-ended',
  });
  dropBridgeCache();
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  return true;
}

/** Unlink: either side may, at any time. The webhooks are deleted and the message map with the link. */
export async function unlinkLink({ guildKey, id, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  await dismantle(link, `unlinked by ${serverLabel(guildKey)}`);
  await recordAudit(guildKey, {
    actor,
    action: 'bridge:unlink',
    detail: `unlinked #${channelName(guildKey, channelOf(link, side))} from #${channelName(guildOf(link, other(side)), channelOf(link, other(side)))} in ${serverName(guildOf(link, other(side)))}`,
    change: null,
  });
  await recordAudit(guildOf(link, other(side)), {
    actor: `${serverName(guildKey)}`,
    action: 'bridge:unlink',
    detail: `${serverName(guildKey)} unlinked #${channelName(guildOf(link, other(side)), channelOf(link, other(side)))}`,
    change: null,
  });
}

/** Remove a link everywhere: queues, webhooks, rows, and tell both channels. */
async function dismantle(link, why) {
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  for (const s of ['a', 'b']) {
    const hook = hookOf(link, s);
    if (hook.id) await transport.deleteHook(guildOf(link, s), hook).catch(() => {});
  }
  await store.deleteLink(link.id);
  failures.delete(link.id);
  dropBridgeCache();
  for (const s of ['a', 'b']) {
    await say(
      guildOf(link, s),
      channelOf(link, s),
      `🌉 **Bridge ended:** ${why}. This channel is no longer shared with the other platform.`
    );
  }
}

/**
 * Sylo was removed from a server: the server on the other end loses its webhook and is told, before the
 * rows go (the purge deletes them). Registered with the purge below.
 */
export async function bridgeServerLeft(key) {
  const links = await store.linksOfGuild(key);
  for (const link of links) {
    const side = sideOf(link, key);
    const theirs = other(side);
    const hook = hookOf(link, theirs);
    queue.clear(laneKey(link, 'a'));
    queue.clear(laneKey(link, 'b'));
    if (hook.id) await transport.deleteHook(guildOf(link, theirs), hook).catch(() => {});
    // The leaving server's own webhook goes too (a webhook can be deleted by its token without the bot).
    const own = hookOf(link, side);
    if (own.id) await transport.deleteHook(key, own).catch(() => {});
    await say(
      guildOf(link, theirs),
      channelOf(link, theirs),
      '🌉 **Bridge ended:** the other server removed Sylo. This channel is no longer shared with the other platform.'
    );
    await recordAudit(guildOf(link, theirs), {
      actor: 'Sylo',
      action: 'bridge:unlink',
      detail: 'the server on the other end removed Sylo, so the bridge ended',
      change: null,
    });
  }
  dropBridgeCache();
}
onBeforePurge(bridgeServerLeft);

// --- failures ----------------------------------------------------------------------------------------

/** In a row, how many deliveries of a link failed (reset by a success). In memory: it only gates a pause. */
const failures = new Map();

async function remakeHook(link, side) {
  const key = guildOf(link, side);
  const channelId = channelOf(link, side);
  const old = hookOf(link, side);
  const made = await transport.createHook(key, channelId, HOOK_NAME);
  await store.setLinkHook(link.id, side, made);
  dropBridgeCache();
  if (old.id) await transport.deleteHook(key, old).catch(() => {});
  return { ...made, channelId };
}
// One recreation at a time per webhook, so a burst of failing sends makes one new webhook, not many.
const remaking = new Map();
function recreateHook(link, side) {
  const id = laneKey(link, side);
  if (!remaking.has(id)) {
    remaking.set(
      id,
      remakeHook(link, side).finally(() => remaking.delete(id))
    );
  }
  return remaking.get(id);
}

/** Stop a link that cannot work, show why in Health, and say so in both channels. */
export async function failLink(linkId, reason) {
  const link = await store.getLink(linkId);
  // Only a running link is stopped: a link a server paused stays paused (and only that server resumes it).
  if (!link || link.status !== 'active') return;
  await store.setLinkStatus(link.id, { status: 'failed', reason, failures: FAIL_THRESHOLD });
  dropBridgeCache();
  queue.clear(laneKey(link, 'a'));
  queue.clear(laneKey(link, 'b'));
  failures.delete(link.id);
  log.warn('bridge', `link ${link.id} stopped: ${reason}`);
  for (const s of ['a', 'b']) {
    await recordAudit(guildOf(link, s), {
      actor: 'Sylo',
      action: 'bridge:stopped',
      detail:
        `the bridge of #${channelName(guildOf(link, s), channelOf(link, s))} stopped: ${reasonText(reason)}`.slice(
          0,
          500
        ),
      change: null,
    });
    await say(
      guildOf(link, s),
      channelOf(link, s),
      `🌉 **Bridge stopped.** Messages are no longer shared. Server admins can see why under Health in the Sylo dashboard and resume it there.`
    );
  }
}

/** A delivery to `side`'s channel failed for good (after the queue's own retries). */
async function noteFailure(link, side, err) {
  if (err instanceof BridgeQueueError) {
    log.debug('bridge', `link ${link.id}: a message was dropped (${err.reason})`);
    return;
  }
  const kind = err?.failure?.kind ?? classifyError(err).kind;
  if (kind === 'bad-request' || kind === 'message-gone') {
    log.debug('bridge', `link ${link.id}: the platform refused one message (${kind})`);
    return;
  }
  if (err?.code === 'NO_GUILD' || err?.code === 'NO_CHANNEL') return failLink(link.id, 'channel-missing');
  if (kind === 'forbidden') return failLink(link.id, 'permissions');
  if (kind === 'hook-gone') return failLink(link.id, 'webhook');
  const n = (failures.get(link.id) ?? 0) + 1;
  failures.set(link.id, n);
  log.warn('bridge', `link ${link.id}: delivery to ${side} failed (${n} in a row): ${err?.message ?? err}`);
  if (n >= FAIL_THRESHOLD) return failLink(link.id, 'unreachable');
  return undefined;
}

// --- reading a message -------------------------------------------------------------------------------

const toList = (collection) =>
  collection
    ? typeof collection.values === 'function'
      ? [...collection.values()]
      : Array.isArray(collection)
        ? collection
        : []
    : [];

const displayNameOf = (message) =>
  message.member?.displayName ??
  message.author?.globalName ??
  message.author?.displayName ??
  message.author?.username ??
  'someone';

function avatarOf(message) {
  try {
    const url =
      message.member?.displayAvatarURL?.({ size: 128 }) ??
      message.author?.displayAvatarURL?.({ size: 128, extension: 'png' }) ??
      message.author?.avatarURL?.();
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Names for the mentions in a message, from what the platform sent with it and the server's caches. */
function nameResolvers(message, guild) {
  const m = message.mentions;
  const users = Array.isArray(m) ? m : toList(m?.users);
  return {
    user: (id) =>
      m?.members?.get?.(id)?.displayName ??
      users.find((u) => u.id === id)?.displayName ??
      users.find((u) => u.id === id)?.username ??
      guild?.members?.cache?.get?.(id)?.displayName ??
      guild?.members?.cache?.get?.(id)?.user?.username,
    role: (id) => m?.roles?.get?.(id)?.name ?? guild?.roles?.cache?.get?.(id)?.name,
    channel: (id) => guild?.channels?.cache?.get?.(id)?.name,
  };
}

/** A custom emoji of the same name in the server the copy goes to. */
function emojiFinder(guild) {
  return (name) => {
    const wanted = String(name).toLowerCase();
    for (const e of toList(guild?.emojis?.cache)) if (String(e.name).toLowerCase() === wanted) return e;
    return undefined;
  };
}

/** Is this a message a person (or an allowed bot) wrote, not a join notice, pin notice or other system message? */
function isChatMessage(message) {
  if (message.system) return false;
  const type = message.type;
  return (
    type === undefined || type === null || type === 0 || type === 19 || type === 'Default' || type === 'Reply'
  );
}

const SUFFIX = /\s\[(?:Discord|Fluxer)\]$/;

async function replyInfo(message, link, side) {
  const refId = message.reference?.messageId ?? message.messageReference?.messageId;
  if (!refId) return null;
  const mapped = await store.mappingOf(link.id, side, refId);
  let ref = message.referencedMessage ?? null;
  if (!ref && typeof message.fetchReference === 'function') {
    try {
      ref = await message.fetchReference();
    } catch {
      ref = null;
    }
  }
  const theirs = other(side);
  return {
    name: ref
      ? String(ref.member?.displayName ?? ref.author?.username ?? 'someone').replace(SUFFIX, '')
      : 'someone',
    raw: ref?.content ?? '',
    ref,
    url: mapped ? jumpUrl(guildOf(link, theirs), channelOf(link, theirs), mapped.counterpartId) : undefined,
  };
}

/**
 * Everything a copy of `message` needs: the sender's name and picture, the text with its mentions made
 * harmless, the files (downloaded within limits, the rest as links), embeds, stickers and a poll as text.
 * Null when there is nothing to show.
 */
async function buildCopy(message, link, side, { guildKey }) {
  const srcGuild = guildByKey(guildKey);
  const dstKey = guildOf(link, other(side));
  const dstGuild = guildByKey(dstKey);
  const options = optionsOf(link, side);
  const names = nameResolvers(message, srcGuild);
  const find = emojiFinder(dstGuild);
  const convert = (text) => mapEmoji(neutraliseMentions(text, names), find);

  const body = convert(String(message.content ?? ''));
  const embeds = plainEmbeds(message.embeds, (t) => plainTimestamps(convert(t)));

  const reply = await replyInfo(message, link, side);
  const head = reply
    ? replyHead({
        name: reply.name,
        snippet: convert(reply.raw).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
        url: reply.url,
      })
    : '';

  const attachments = toList(message.attachments).map((a) => ({
    name: a.name ?? a.filename ?? 'file',
    url: a.url,
    size: a.size,
  }));
  const plan = planAttachments(attachments, { upload: options.uploadFiles });
  const files = [];
  const links = [...plan.links];
  // The files are held in memory until the copy is sent (and its retries are over), so the process-wide budget
  // is held that long too: `release` gives it back, once.
  const held = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const n of held) releaseDownload(n);
  };
  for (const a of plan.upload) {
    // No room in the process-wide budget: a link, never a wait.
    if (!reserveDownload(a.size)) {
      links.push(a);
      continue;
    }
    try {
      const res = await download(a.url, FILE_BYTES_LIMIT);
      if (!res.ok || !res.body?.length) throw new Error(`HTTP ${res.status}`);
      files.push({ name: a.name, data: res.body });
      held.push(a.size);
    } catch (err) {
      releaseDownload(a.size);
      log.debug('bridge', `file left as a link (${err?.message ?? err})`);
      links.push(a);
    }
  }

  const poll = message.poll
    ? pollText({
        question: message.poll.question?.text ?? message.poll.question,
        answers: toList(message.poll.answers).map((a) => ({ text: a.text, emoji: a.emoji?.name })),
      })
    : '';
  // The sticker, poll and file names are text from the other side too: the same mention rules apply.
  const tail = convert(
    [...stickerLines(toList(message.stickers)), poll, ...fileLinkLines(links)].filter(Boolean).join('\n')
  );

  const content = joinParts([head, body, tail]);
  if (!content && !embeds.length && !files.length) {
    release();
    return null;
  }
  return {
    release,
    content,
    head,
    body,
    tail,
    embeds,
    files,
    username: senderName(displayNameOf(message), platformOf(guildKey), {
      forDiscord: platformOf(dstKey) === 'discord',
    }),
    avatarUrl: avatarOf(message),
  };
}

// --- relaying ----------------------------------------------------------------------------------------

/**
 * A webhook send that gives way when the platform refuses it (a 400): first with a plain sender name (some
 * names are refused), then without the files and embeds (the text still crosses).
 */
async function sendCopy(dstKey, hook, payload) {
  try {
    return await transport.send(dstKey, hook, payload);
  } catch (err) {
    if (classifyError(err).kind !== 'bad-request') throw err;
    const plain = {
      ...payload,
      username: `Bridge [${platformName(dstKey) === 'Discord' ? 'Fluxer' : 'Discord'}]`,
    };
    try {
      return await transport.send(dstKey, hook, plain);
    } catch (err2) {
      if (classifyError(err2).kind !== 'bad-request' || (!payload.files && !payload.embeds)) throw err2;
      log.info('bridge', 'a message crossed without its files and embeds: the platform refused them');
      return transport.send(dstKey, hook, {
        content: payload.content || '(a file or embed could not be copied)',
        username: plain.username,
        avatarUrl: payload.avatarUrl,
      });
    }
  }
}

/**
 * Run a transport call with the link's webhook, making a new webhook once if the platform says it is gone
 * (or if the stored token cannot be read any more). Resolves `{ value, hook }`: the webhook that was used.
 */
async function withHook(link, side, call) {
  let hook = hookOf(link, side);
  if (!hook.id || !hook.token) hook = await recreateHook(link, side);
  try {
    return { value: await call(hook), hook };
  } catch (err) {
    if (classifyError(err).kind !== 'hook-gone') throw err;
    hook = await recreateHook(link, side);
    return { value: await call(hook), hook };
  }
}

/**
 * Remove a copy from the target channel: through the webhook that posted it, and when that cannot (the
 * webhook was replaced or is gone) as the bot, which needs Manage Messages there. True when the copy is gone.
 */
async function removeCopy(link, target, copyId, copyHookId) {
  const dstKey = guildOf(link, target);
  const hook = hookOf(link, target);
  if (hook.id && hook.token && (!copyHookId || copyHookId === hook.id)) {
    try {
      await transport.remove(dstKey, hook, copyId);
      return true;
    } catch (err) {
      const kind = classifyError(err, 'delete').kind;
      if (kind === 'message-gone') return true;
      // A temporary error: the delete job is tried again (the queue backs off), the map entry stays.
      if (kind === 'rate' || kind === 'transient') throw err;
    }
  }
  try {
    await transport.botDelete(dstKey, channelOf(link, target), copyId);
    return true;
  } catch (err) {
    const kind = classifyError(err, 'delete').kind;
    if (kind === 'message-gone') return true;
    if (kind === 'rate' || kind === 'transient') throw err;
    log.debug('bridge', `a copy could not be removed (link ${link.id}): ${err?.message ?? err}`);
    return false;
  }
}

/** Can a message in this channel be relayed at all right now? Loop, bot and age rules. */
async function allowed(message, link, side, key) {
  if (!isChatMessage(message)) return false;
  // Webhook messages never cross, whatever the bots option says: they are what bridges (this one and any
  // other) post, and relaying them is how two bridges on the same channels would feed each other forever.
  if (message.webhookId) return false;
  if (message.author?.id && message.author.id === message.client?.user?.id) return false;
  if (message.author?.bot) {
    if (!optionsOf(link, side).bots) return false;
    // A bot that already carries a platform tag in its name is a bridge's relay account.
    if (SUFFIX.test(String(message.author.username ?? ''))) return false;
  }
  const changed = ownerChangedSide(link);
  if (changed) {
    await pauseForOwner(link, changed);
    return false;
  }
  const theirKey = guildOf(link, other(side));
  if (!(await isModuleEnabled(theirKey, 'bridge'))) return false;
  // The age rule on every message: a channel can change after the link was made.
  const mine = channelIn(key, message.channelId);
  const theirs = channelIn(theirKey, channelOf(link, other(side)));
  if (!mine || !theirs) {
    await failLink(link.id, 'channel-missing');
    return false;
  }
  if (ageRestricted(key, mine) !== ageRestricted(theirKey, theirs)) {
    await failLink(link.id, 'age-restriction');
    return false;
  }
  // A link the server mirror made also keeps the two channels equally open (a channel can turn private later).
  if (madeByMirror(link) && !samePrivacy(key, mine, theirKey, theirs)) {
    await failLink(link.id, 'visibility');
    return false;
  }
  return true;
}

/** `messageCreateAny`: relay a new message to the other end of its channel's link. */
export async function handleMessage(message, _config, key) {
  const found = await findLink(key, message.channelId);
  if (!found || found.link.status !== 'active') return;
  const { link, side } = found;
  if (wasDeleted(key, message.id)) return;
  if (!(await allowed(message, link, side, key))) return;

  const target = other(side);
  const dstKey = guildOf(link, target);
  let built;
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current || current.status !== 'active') return null;
    if (wasDeleted(key, message.id)) return null;
    built ??= await buildCopy(message, current, side, { guildKey: key });
    if (!built || wasDeleted(key, message.id)) return null;
    const payload = {
      content: built.content || undefined,
      username: built.username,
      avatarUrl: built.avatarUrl,
      embeds: built.embeds.length ? built.embeds : undefined,
      files: built.files.length ? built.files : undefined,
    };
    const { value: copyId, hook } = await withHook(current, target, (h) => sendCopy(dstKey, h, payload));
    if (failures.has(current.id)) failures.delete(current.id);
    // Deleted while it was being sent (moderation can be quicker than the relay): take the copy down again.
    try {
      await store.saveMapping(current.id, side, {
        sourceId: message.id,
        copyId,
        hookId: hook.id,
        hash: hashContent(`${built.body}\n${JSON.stringify(built.embeds)}`),
        extra: { head: built.head.slice(0, 900), tail: built.tail.slice(0, 900) },
      });
    } catch (err) {
      log.warn('bridge', `could not remember a copy: ${err?.message ?? err}`);
    }
    if (wasDeleted(key, message.id)) {
      // Deleted while it was being sent: take the copy down again. If that cannot be done right now, the delete
      // job (which keeps trying, and keeps the map entry) does it.
      const gone = await removeCopy(current, target, copyId, hook.id).catch(() => false);
      if (gone) await store.deleteMapping(current.id, side, message.id).catch(() => {});
      else await deleteCopies(current, side, [message.id]);
    }
    return copyId;
  };
  track(
    queue
      .enqueue(laneKey(link, target), job, { op: 'send', gapMs: gapOf(link, target, 'send') })
      .catch((err) => noteFailure(link, target, err))
      .finally(() => built?.release?.())
  );
}

/** `messageUpdate`: a message that was relayed is edited on the other side. */
export async function handleUpdate({ new: updated }, _config, key) {
  let message = updated;
  if (message?.partial && typeof message.fetch === 'function') {
    try {
      message = await message.fetch();
    } catch {
      return;
    }
  }
  if (!message?.channelId) return;
  const found = await findLink(key, message.channelId);
  if (!found || found.link.status !== 'active') return;
  const { link, side } = found;
  if (!(await allowed(message, link, side, key))) return;

  const target = other(side);
  const dstKey = guildOf(link, target);
  // The map is read inside the job: the job waits behind the send of the same message in the same lane, so
  // an edit that comes quickly still finds the copy.
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current || current.status !== 'active') return null;
    const map = await store.mappingOf(current.id, side, message.id);
    if (!map?.isOriginal) return null;
    const names = nameResolvers(message, guildByKey(key));
    const find = emojiFinder(guildByKey(dstKey));
    const convert = (text) => mapEmoji(neutraliseMentions(text, names), find);
    const body = convert(String(message.content ?? ''));
    const embeds = plainEmbeds(message.embeds, (t) => plainTimestamps(convert(t)));
    const hash = hashContent(`${body}\n${JSON.stringify(embeds)}`);
    // An edit event also fires when only a link preview appeared; nothing visible changed then.
    if (hash === map.contentHash) return null;
    const content = joinParts([map.extra?.head, body, map.extra?.tail]);
    const hook = hookOf(current, target);
    // A token that cannot be read any more (the session secret changed): make the webhook again for what comes
    // next. The copy was posted by the old one and cannot be edited, which is not a failure of the link.
    if (hook.id && !hook.token) {
      await recreateHook(current, target);
      return null;
    }
    // The copy can only be edited by the webhook that posted it; if that one was replaced, leave it as it was.
    if (!hook.id || (map.copyHookId && map.copyHookId !== hook.id)) return null;
    await transport.edit(dstKey, hook, map.counterpartId, { content: content || ZWSP, embeds });
    await store.setMappingHash(current.id, map.aMessageId, map.bMessageId, hash);
    return map.counterpartId;
  };
  track(
    queue
      .enqueue(laneKey(link, target), job, { op: 'edit', gapMs: gapOf(link, target, 'edit') })
      .catch((err) => noteFailure(link, target, err))
  );
}

/**
 * Take the copies of deleted messages down. A removal by a moderator must reach the other side, so this
 * never depends on the state the link has right now: it runs while the link is paused or stopped, it looks
 * the map up inside the job (behind the send of the same message in the same lane), it is not dropped for a
 * full or slow lane, and when the webhook cannot do it the bot does. A purge of many messages is one job.
 */
async function deleteCopies(link, side, ids) {
  const target = other(side);
  const sourceKey = guildOf(link, side);
  for (const id of ids) markDeleted(sourceKey, id);
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current) return null;
    for (const id of ids) {
      const map = await store.mappingOf(current.id, side, id);
      if (!map) continue;
      // Someone removed a copy: forget it, and leave the original alone. The map entry stays until the copy
      // is really gone, so a delete that failed for good can still be tried again later.
      const gone = map.isOriginal
        ? await removeCopy(current, target, map.counterpartId, map.copyHookId)
        : true;
      if (gone) await store.deleteMapping(current.id, side, id);
    }
    return ids.length;
  };
  track(
    queue
      .enqueue(laneKey(link, target), job, { op: 'delete', gapMs: gapOf(link, target, 'delete') })
      .catch((err) =>
        log.debug('bridge', `a delete was not carried across (link ${link.id}): ${err?.message ?? err}`)
      )
  );
}

/** `messageDelete`: the copy of a deleted message is deleted too. */
export async function handleDelete(message, _config, key) {
  if (!message?.channelId || !message.id) return;
  // Not only on a running link: a removal while the link is paused or stopped still has to reach the copy.
  const found = await findLink(key, message.channelId);
  if (!found) return;
  await deleteCopies(found.link, found.side, [String(message.id)]);
}

/** `messageDeleteBulk`: the same for a purge of many messages. */
export async function handleBulkDelete({ messages, channel }, _config, key) {
  const ids = typeof messages?.keys === 'function' ? [...messages.keys()].map(String) : [];
  // Fluxer may not have the channel cached: the deleted messages carry its id as well.
  const channelId = channel?.id ?? [...(messages?.values?.() ?? [])][0]?.channelId;
  if (!channelId || !ids.length) return;
  const found = await findLink(key, channelId);
  if (!found) return;
  await deleteCopies(found.link, found.side, ids);
}

/** `guildMemberAdd`: a join notice on the other side, for the links whose server turned it on. */
export async function handleJoin(member, _config, key) {
  const links = (await store.linksOfGuild(key)).filter((l) => l.status === 'active');
  for (const link of links) {
    const side = sideOf(link, key);
    const options = optionsOf(link, side);
    if (!options.joinMessages) continue;
    if (member.user?.bot && !options.bots) continue;
    const changed = ownerChangedSide(link);
    if (changed) {
      await pauseForOwner(link, changed);
      continue;
    }
    const target = other(side);
    const dstKey = guildOf(link, target);
    if (!(await isModuleEnabled(dstKey, 'bridge'))) continue;
    const who = escapeMarkdown(
      inertAt(String(member.displayName ?? member.user?.username ?? 'Someone')).slice(0, 80)
    );
    const payload = {
      content: `👋 **${who}** joined **${serverLabel(key)}**`,
      username: senderName(guildByKey(key)?.name ?? 'Server', platformOf(key), {
        forDiscord: platformOf(dstKey) === 'discord',
      }),
    };
    track(
      queue
        .enqueue(
          laneKey(link, target),
          async () => {
            const current = await store.getLink(link.id);
            if (!current || current.status !== 'active') return null;
            return (await withHook(current, target, (hook) => sendCopy(dstKey, hook, payload))).value;
          },
          { op: 'send', gapMs: gapOf(link, target, 'send') }
        )
        .catch((err) => noteFailure(link, target, err))
    );
  }
}

/** `channelDelete`: a bridged channel that is gone stops its link. */
export async function handleChannelDelete(channel, _config, key) {
  const found = await findLink(key, channel.id);
  if (!found) return;
  const { link } = found;
  if (link.status === 'active') {
    await failLink(link.id, 'channel-deleted');
    return;
  }
  // Paused or already stopped: it stays as it is, but Health must say the channel is gone (resume would refuse).
  await store.setLinkStatus(link.id, {
    status: link.status,
    pausedSide: link.pausedSide,
    reason: 'channel-deleted',
    failures: link.failureCount,
  });
  dropBridgeCache();
  await recordAudit(key, {
    actor: 'Sylo',
    action: 'bridge:stopped',
    detail: `a bridged channel was deleted while the bridge of #${channel.name ?? 'it'} was not running`,
    change: null,
  });
}

/**
 * Check the owners of every running link (a change of owner pauses it). Messages check as they come; this
 * covers a quiet link, so a new owner is asked to confirm without waiting for traffic.
 */
export async function sweepOwners() {
  let paused = 0;
  for (const link of await store.activeLinks()) {
    const changed = ownerChangedSide(link);
    if (changed) {
      await pauseForOwner(link, changed);
      paused += 1;
    }
  }
  return paused;
}
every('bridge', 5 * 60_000, () => sweepOwners());

on('bridge', 'messageCreateAny', handleMessage);
on('bridge', 'messageUpdate', handleUpdate);
on('bridge', 'messageDelete', handleDelete);
on('bridge', 'messageDeleteBulk', handleBulkDelete);
on('bridge', 'guildMemberAdd', handleJoin);
on('bridge', 'channelDelete', handleChannelDelete);

// --- what the dashboard shows ------------------------------------------------------------------------

/** The end of a link on the other server, as much as both servers agreed to show each other. */
function endView(key, channelId) {
  const channel = channelIn(key, channelId);
  return {
    platform: platformOf(key),
    server: guildByKey(key)?.name ?? 'Unknown server',
    channel: channel?.name ?? 'unknown channel',
    ageRestricted: ageRestricted(key, channel),
  };
}

/** One link as the server `key` sees it (never a webhook token). */
export function linkView(link, key, hold = 'none') {
  const side = sideOf(link, key);
  const theirs = other(side);
  return {
    id: link.id,
    status: link.status,
    pausedByMe: link.status === 'paused' && link.pausedSide === side,
    pausedByThem: link.status === 'paused' && link.pausedSide === theirs,
    // Whether this server's owner can press Resume: a stopped link, one this server paused, or one nobody holds
    // (its server mirror ended). A link held by a running-state mirror comes back with the mirror.
    resumable:
      hold !== 'held' &&
      (link.status === 'failed' ||
        (link.status === 'paused' && (link.pausedSide === side || !link.pausedSide))),
    problem: link.status === 'failed' ? { code: link.failReason, text: reasonText(link.failReason) } : null,
    // Why a paused link is paused beyond "a server paused it": its owner changed, or its channel is gone.
    pauseNote:
      hold === 'held' && link.status !== 'active'
        ? reasonText('mirror')
        : link.status === 'paused' && link.failReason
          ? reasonText(hold === 'ended' ? 'mirror-ended' : link.failReason)
          : null,
    mine: { channelId: channelOf(link, side), ...endView(key, channelOf(link, side)) },
    theirs: endView(guildOf(link, theirs), channelOf(link, theirs)),
    options: optionsOf(link, side),
    theirOptions: optionsOf(link, theirs),
    createdAt: link.createdAt,
    // Only this server's own dashboard name: the other server's staff are not shown to it.
    by: side === 'a' ? link.requestedBy : link.acceptedBy,
    queued: queue.stats(laneKey(link, theirs)).queued,
    dropped: queue.stats(laneKey(link, theirs)).dropped,
  };
}

/** Everything the Bridge page needs for a server. */
export async function bridgeOverview(key) {
  const guild = guildByKey(key);
  const links = await store.linksOfGuild(key);
  const requests = await store.pendingCodes(key);
  const taken = new Set([
    ...links.map((l) => channelOf(l, sideOf(l, key))),
    ...requests.map((r) => r.channelId),
  ]);
  return {
    platform: platformOf(key),
    bothPlatforms: Boolean(runtime.clients.discord && runtime.clients.fluxer),
    enabled: (await getGuildModule(key, 'bridge')).enabled,
    limits: { links: maxLinks, requests: MAX_REQUESTS },
    links: await Promise.all(links.map(async (l) => linkView(l, key, await mirrorHold(l)))),
    requests: requests.map((r) => ({
      id: r.id,
      channelId: r.channelId,
      channel: channelIn(key, r.channelId)?.name ?? 'unknown channel',
      expiresAt: r.expiresAt,
      requestedBy: r.requestedBy,
    })),
    channels: toList(guild?.channels?.cache)
      .filter(isTextChannel)
      .sort((x, y) => (x.rawPosition ?? 0) - (y.rawPosition ?? 0))
      .map((c) => ({ id: c.id, name: c.name, ageRestricted: ageRestricted(key, c), taken: taken.has(c.id) })),
  };
}

/**
 * The links of a server that need attention, for the Health page: a stopped link, and the permissions
 * the bridge needs in its channels are checked by the generic channel check there.
 */
export async function bridgeProblems(key) {
  return (
    (await store.linksOfGuild(key))
      // A link the server mirror holds is covered by the mirror's own Health entry.
      .filter(
        (l) => l.status === 'failed' || (l.status === 'paused' && l.failReason && l.failReason !== 'mirror')
      )
      .map((l) => {
        const side = sideOf(l, key);
        return {
          linkId: l.id,
          channelId: channelOf(l, side),
          code: l.failReason,
          text: reasonText(l.failReason),
        };
      })
  );
}

/** The bridged channels of a server, with the permissions the bridge needs in each. */
export async function bridgedChannels(key) {
  return (await store.linksOfGuild(key)).map((l) => channelOf(l, sideOf(l, key)));
}
