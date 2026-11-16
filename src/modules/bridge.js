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
import { getGuildModule, isModuleEnabled } from '../db/modules.js';
import { recordAudit } from '../db/audit.js';
import { onBeforePurge } from '../db/purge.js';
import * as store from '../db/bridge.js';
import { runtime } from '../runtime.js';
import { splitPlatformGuildId } from '../lib/platformId.js';
import { guildByKey } from '../platform/platformOf.js';
import { createWebhookTransport } from '../platform/webhooks.js';
import { jumpUrl } from './quoteBoard.js';
import { safeFetch } from '../lib/safeFetch.js';
import { log } from '../lib/log.js';
import { BridgeQueueError, classifyError, createRelayQueue } from './lib/bridgeQueue.js';
import {
  FILE_BYTES_LIMIT,
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
/** The most links a server can have, and the most requests it can have waiting. */
export const MAX_LINKS = 10;
export const MAX_REQUESTS = 5;

/** How many failed deliveries in a row stop a link. */
export const FAIL_THRESHOLD = 5;
const HOOK_NAME = 'Sylo bridge';
const CACHE_MS = 60_000;

/** A refusal the dashboard shows as it is. `status` is the HTTP answer. */
export class BridgeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
  }
}

// --- wiring that tests replace -----------------------------------------------------------------------

let transport = createWebhookTransport();
let queue = createRelayQueue();
let download = (url, maxBytes) => safeFetch(url, { maxBytes, timeoutMs: 15_000 });

/** Use another transport, queue or downloader (tests); call with nothing to go back to the real ones. */
export function useBridgeParts({ transport: t, queue: q, download: d } = {}) {
  transport = t ?? createWebhookTransport();
  queue = q ?? createRelayQueue();
  download = d ?? ((url, maxBytes) => safeFetch(url, { maxBytes, timeoutMs: 15_000 }));
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
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

const channelIn = (key, channelId) => guildByKey(key)?.channels?.cache?.get?.(channelId) ?? null;
const isTextChannel = (channel) => Boolean(channel) && TEXT_TYPES.has(channel.type);
const isAgeRestricted = (channel) => channel?.nsfw === true;

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
  `🌉 **Bridge on.** Messages in this channel are shared with #${channelName(theirKey, theirChannelId)} in ` +
  `**${serverName(theirKey)}** on ${platformName(theirKey)}, and theirs appear here. Nobody is pinged across ` +
  `the bridge. Server admins can pause or unlink it at any time in the Sylo dashboard.`;

const REASONS = {
  permissions:
    'Sylo is missing a permission it needs here (Manage Webhooks, or to send in the channel). Fix the permission, then resume the bridge in the dashboard.',
  webhook: 'Sylo could not make a new webhook after the old one was deleted.',
  unreachable: 'Messages could not be delivered several times in a row.',
  'channel-deleted': 'A bridged channel was deleted.',
  'channel-missing': 'Sylo cannot see one of the bridged channels.',
  'age-restriction':
    'One channel changed its age restriction, so the two no longer match. An age-restricted channel can only be bridged with an age-restricted one.',
};
/** The text a link's stored failure reason stands for. */
export const reasonText = (code) => REASONS[code] ?? 'The bridge stopped working.';

// --- the pieces of a link, looked up on the platforms ------------------------------------------------

/**
 * Check a channel of a server can be bridged: Sylo sees it, it is a normal text channel, and Sylo may
 * view it, send in it and manage webhooks there.
 * @returns {{ guild: any, channel: any }}
 */
function checkChannel(key, channelId) {
  const guild = guildByKey(key);
  if (!guild) throw new BridgeError('Sylo is not in that server.', 404);
  const channel = guild.channels?.cache?.get?.(channelId);
  if (!isTextChannel(channel)) throw new BridgeError('Pick a normal text channel of this server.');
  const perms = channel.permissionsFor?.(guild.members?.me);
  const missing = ['ViewChannel', 'SendMessages', 'ManageWebhooks'].filter((p) => perms?.has?.(p) === false);
  if (missing.length) {
    throw new BridgeError(
      `Sylo needs ${missing.join(', ')} in #${channel.name}. Give Sylo's role those permissions there first.`
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
      409
    );
  }
}

/** The age rule: an age-restricted channel only with an age-restricted channel. */
function checkAge(a, b) {
  if (isAgeRestricted(a) !== isAgeRestricted(b)) {
    throw new BridgeError(
      'An age-restricted channel can only be bridged with another age-restricted channel.'
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
  if ((await store.linkCount(guildKey)) >= MAX_LINKS) {
    throw new BridgeError(`A server can have at most ${MAX_LINKS} bridged channels.`, 409);
  }
  if ((await store.pendingCodeCount(guildKey)) >= MAX_REQUESTS) {
    throw new BridgeError(`At most ${MAX_REQUESTS} requests can wait at once. Cancel one first.`, 409);
  }
  const made = await store.createCode({
    guildId: guildKey,
    channelId,
    options: normaliseOptions(options),
    requestedBy: actor,
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
  if ((await store.linkCount(guildKey)) >= MAX_LINKS) {
    throw new BridgeError(`A server can have at most ${MAX_LINKS} bridged channels.`, 409);
  }

  const request = await store.peekCode(code);
  if (!request) throw new BridgeError(INVALID_CODE, 404);
  if (request.guildId === guildKey) throw new BridgeError('That request was made in this server.', 409);
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
  checkAge(mine.channel, theirs.channel);

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
    `🌉 **Bridge paused** by ${serverName(guildKey)}. Nothing is shared until they resume it.`
  );
}

/**
 * Resume a link. A link a server paused can only be resumed by that server; one Sylo stopped (a failure)
 * can be resumed by either, after the cause is fixed: the channels, permissions, webhooks and the age rule
 * are checked again first.
 */
export async function resumeLink({ guildKey, id, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  if (link.status === 'active') throw new BridgeError('That bridge is already running.', 409);
  if (link.status === 'paused' && link.pausedSide !== side) {
    throw new BridgeError('The other server paused this bridge, so only they can resume it.', 403);
  }
  requireBothPlatforms();
  await requireModule(link.guildA);
  await requireModule(link.guildB);
  const a = checkChannel(link.guildA, link.channelA);
  const b = checkChannel(link.guildB, link.channelB);
  checkAge(a.channel, b.channel);
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
}

/** Unlink: either side may, at any time. The webhooks are deleted and the message map with the link. */
export async function unlinkLink({ guildKey, id, actor }) {
  const { link, side } = await ownLink(guildKey, id);
  await dismantle(link, `unlinked by ${serverName(guildKey)}`);
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
  if (!link || link.status === 'failed') return;
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
  for (const a of plan.upload) {
    try {
      const res = await download(a.url, FILE_BYTES_LIMIT);
      if (!res.ok || !res.body?.length) throw new Error(`HTTP ${res.status}`);
      files.push({ name: a.name, data: res.body });
    } catch (err) {
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
  const tail = [...stickerLines(toList(message.stickers)), poll, ...fileLinkLines(links)]
    .filter(Boolean)
    .join('\n');

  const content = joinParts([head, body, tail]);
  if (!content && !embeds.length && !files.length) return null;
  return {
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

/** A webhook send that tries once more with a plain name when the platform refuses the sender's name. */
async function sendCopy(dstKey, hook, payload) {
  try {
    return await transport.send(dstKey, hook, payload);
  } catch (err) {
    if (classifyError(err).kind === 'bad-request' && payload.username) {
      return transport.send(dstKey, hook, {
        ...payload,
        username: `Bridge [${platformName(dstKey) === 'Discord' ? 'Fluxer' : 'Discord'}]`,
      });
    }
    throw err;
  }
}

/** Run a transport call with the link's webhook, making a new webhook once if the platform says it is gone. */
async function withHook(link, side, call) {
  let hook = hookOf(link, side);
  try {
    return await call(hook);
  } catch (err) {
    if (classifyError(err).kind !== 'hook-gone') throw err;
    hook = await recreateHook(link, side);
    return call(hook);
  }
}

/** Can a message in this channel be relayed at all right now? Loop, bot and age rules. */
async function allowed(message, link, side, key) {
  if (!isChatMessage(message)) return false;
  // Never again what a bridge webhook posted (any link's), and never Sylo's own messages.
  if (message.webhookId && (await store.linkForHook(message.webhookId))) return false;
  if (message.author?.id && message.author.id === message.client?.user?.id) return false;
  if (message.author?.bot || message.webhookId) {
    if (!optionsOf(link, side).bots) return false;
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
  if (isAgeRestricted(mine) !== isAgeRestricted(theirs)) {
    await failLink(link.id, 'age-restriction');
    return false;
  }
  return true;
}

/** `messageCreateAny`: relay a new message to the other end of its channel's link. */
export async function handleMessage(message, _config, key) {
  const found = await findLink(key, message.channelId);
  if (!found || found.link.status !== 'active') return;
  const { link, side } = found;
  if (!(await allowed(message, link, side, key))) return;

  const target = other(side);
  const dstKey = guildOf(link, target);
  let built;
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current || current.status !== 'active') return null;
    built ??= await buildCopy(message, current, side, { guildKey: key });
    if (!built) return null;
    const payload = {
      content: built.content || undefined,
      username: built.username,
      avatarUrl: built.avatarUrl,
      embeds: built.embeds.length ? built.embeds : undefined,
      files: built.files.length ? built.files : undefined,
    };
    const copyId = await withHook(current, target, (hook) => sendCopy(dstKey, hook, payload));
    try {
      await store.saveMapping(current.id, side, {
        sourceId: message.id,
        copyId,
        hookId: hookOf(current, target).id,
        hash: hashContent(`${built.body}\n${JSON.stringify(built.embeds)}`),
        extra: { head: built.head.slice(0, 900), tail: built.tail.slice(0, 900) },
      });
    } catch (err) {
      log.warn('bridge', `could not remember a copy: ${err?.message ?? err}`);
    }
    if (failures.has(current.id)) failures.delete(current.id);
    return copyId;
  };
  track(
    queue.enqueue(laneKey(link, target), job, { op: 'send' }).catch((err) => noteFailure(link, target, err))
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
  const map = await store.mappingOf(link.id, side, message.id);
  if (!map?.isOriginal) return;
  if (!(await allowed(message, link, side, key))) return;

  const target = other(side);
  const dstKey = guildOf(link, target);
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current || current.status !== 'active') return null;
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
    // The copy can only be edited by the webhook that posted it; if that one was replaced, leave it as it was.
    if (!hook.id || (map.copyHookId && map.copyHookId !== hook.id)) return null;
    await transport.edit(dstKey, hook, map.counterpartId, { content: content || ZWSP, embeds });
    await store.setMappingHash(current.id, map.aMessageId, map.bMessageId, hash);
    return map.counterpartId;
  };
  track(
    queue.enqueue(laneKey(link, target), job, { op: 'edit' }).catch((err) => noteFailure(link, target, err))
  );
}

async function deleteCopyOf(link, side, messageId) {
  const map = await store.mappingOf(link.id, side, messageId);
  if (!map) return;
  const target = other(side);
  if (!map.isOriginal) {
    // Someone removed a copy: forget it, and leave the original alone.
    await store.deleteMapping(link.id, side, messageId);
    return;
  }
  const dstKey = guildOf(link, target);
  const job = async () => {
    const current = await store.getLink(link.id);
    if (!current || current.status !== 'active') return null;
    const hook = hookOf(current, target);
    if (hook.id && (!map.copyHookId || map.copyHookId === hook.id)) {
      try {
        await transport.remove(dstKey, hook, map.counterpartId);
      } catch (err) {
        if (classifyError(err, 'delete').kind !== 'message-gone') throw err;
      }
    }
    await store.deleteMapping(current.id, side, messageId);
    return map.counterpartId;
  };
  track(
    queue.enqueue(laneKey(link, target), job, { op: 'delete' }).catch((err) => noteFailure(link, target, err))
  );
}

/** `messageDelete`: the copy of a deleted message is deleted too. */
export async function handleDelete(message, _config, key) {
  if (!message?.channelId || !message.id) return;
  const found = await findLink(key, message.channelId);
  if (!found || found.link.status !== 'active') return;
  await deleteCopyOf(found.link, found.side, message.id);
}

/** `messageDeleteBulk`: the same for a purge of many messages. */
export async function handleBulkDelete({ messages, channel }, _config, key) {
  const ids = typeof messages?.keys === 'function' ? [...messages.keys()] : [];
  // Fluxer may not have the channel cached: the deleted messages carry its id as well.
  const channelId = channel?.id ?? [...(messages?.values?.() ?? [])][0]?.channelId;
  if (!channelId) return;
  const found = await findLink(key, channelId);
  if (!found || found.link.status !== 'active') return;
  for (const id of ids) await deleteCopyOf(found.link, found.side, id);
}

/** `guildMemberAdd`: a join notice on the other side, for the links whose server turned it on. */
export async function handleJoin(member, _config, key) {
  const links = (await store.linksOfGuild(key)).filter((l) => l.status === 'active');
  for (const link of links) {
    const side = sideOf(link, key);
    const options = optionsOf(link, side);
    if (!options.joinMessages) continue;
    if (member.user?.bot && !options.bots) continue;
    const target = other(side);
    const dstKey = guildOf(link, target);
    if (!(await isModuleEnabled(dstKey, 'bridge'))) continue;
    const who = inertAt(String(member.displayName ?? member.user?.username ?? 'Someone')).slice(0, 80);
    const payload = {
      content: `👋 **${who}** joined **${serverName(key)}**`,
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
            return withHook(current, target, (hook) => sendCopy(dstKey, hook, payload));
          },
          { op: 'send' }
        )
        .catch((err) => noteFailure(link, target, err))
    );
  }
}

/** `channelDelete`: a bridged channel that is gone stops its link. */
export async function handleChannelDelete(channel, _config, key) {
  const found = await findLink(key, channel.id);
  if (found) await failLink(found.link.id, 'channel-deleted');
}

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
    ageRestricted: isAgeRestricted(channel),
  };
}

/** One link as the server `key` sees it (never a webhook token). */
export function linkView(link, key) {
  const side = sideOf(link, key);
  const theirs = other(side);
  return {
    id: link.id,
    status: link.status,
    pausedByMe: link.status === 'paused' && link.pausedSide === side,
    pausedByThem: link.status === 'paused' && link.pausedSide === theirs,
    problem: link.status === 'failed' ? { code: link.failReason, text: reasonText(link.failReason) } : null,
    mine: { channelId: channelOf(link, side), ...endView(key, channelOf(link, side)) },
    theirs: endView(guildOf(link, theirs), channelOf(link, theirs)),
    options: optionsOf(link, side),
    theirOptions: optionsOf(link, theirs),
    createdAt: link.createdAt,
    requestedBy: link.requestedBy,
    acceptedBy: link.acceptedBy,
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
    limits: { links: MAX_LINKS, requests: MAX_REQUESTS },
    links: links.map((l) => linkView(l, key)),
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
      .map((c) => ({ id: c.id, name: c.name, ageRestricted: isAgeRestricted(c), taken: taken.has(c.id) })),
  };
}

/**
 * The links of a server that need attention, for the Health page: a stopped link, and the permissions
 * the bridge needs in its channels are checked by the generic channel check there.
 */
export async function bridgeProblems(key) {
  return (await store.linksOfGuild(key))
    .filter((l) => l.status === 'failed')
    .map((l) => {
      const side = sideOf(l, key);
      return {
        linkId: l.id,
        channelId: channelOf(l, side),
        code: l.failReason,
        text: reasonText(l.failReason),
      };
    });
}

/** The bridged channels of a server, with the permissions the bridge needs in each. */
export async function bridgedChannels(key) {
  return (await store.linksOfGuild(key)).map((l) => channelOf(l, sideOf(l, key)));
}
