// The last step of a copy: link every mirrored text channel through the bridge, so a message written in a
// Discord channel appears in its Fluxer copy and the other way round.
//
// What this does, and what it leaves to the bridge (src/modules/bridge.js):
//   - It looks at the channel map of a pair (the id map says which Discord channel is which Fluxer channel) and
//     links every pair of text and announcement channels, through the bridge's own link model and relay.
//   - No link code is used. Both server owners already agreed to the mirror, and the pair keeps who and when;
//     the link records those two people (as "<name> (server mirror)") as the ones who agreed to it.
//   - Every rule of the bridge holds for such a link (see createMirrorLink): age restriction, the two channels
//     being as private as each other, the owners' and Sylo's own rights in the channels, a visible notice in
//     both channels, bots off, a webhook per channel. A channel pair that fails a rule is skipped and reported,
//     and the rest go on. The Bridge module is switched on in both servers (it has to be on for a link to carry
//     anything) and both servers' audit logs say so.
//   - It is safe to run again: a pair that already has its link (made by the mirror, or found already linked
//     as this very pair) is left alone, and only missing pairs are linked. A pair that was unlinked on purpose
//     afterwards (on the Bridge page) is not linked again; that decision belongs to the owners.
//   - The links are held with the mirror: a mirror that is paused, stopped or removed pauses them, and they run
//     again when the mirror does (syncMirrorLinks, releaseMirrorLinks; the engine calls both).
//
// Linking is done in batches of LINKS_PER_RUN; `remaining` says more are waiting, and the engine queues another
// run. It throws only for a failure the copy should retry (the queue retries it with a delay).
import { ChannelType } from 'discord.js';
import { config } from '../config.js';
import { log } from '../lib/log.js';
import { runtime } from '../runtime.js';
import { guildByKey } from '../platform/platformOf.js';
import {
  PAIR_STATUS,
  getMapping,
  getMirrorLink,
  getPair,
  listMappings,
  listMirrorLinks,
  putMapping,
  putMirrorLink,
} from '../db/mirror.js';
import { linkForChannel } from '../db/bridge.js';
import { isModuleEnabled } from '../db/modules.js';
import {
  BridgeError,
  createMirrorLink,
  enableBridgeForMirror,
  holdMirrorLink,
  releaseMirrorLink,
  resumeMirrorLink,
} from '../modules/bridge.js';

/** How many pairs one run links (each makes two webhooks and posts two notices). */
export const LINKS_PER_RUN = 25;
const PAUSE_BETWEEN_MS = 500;

const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const isText = (channel) => Boolean(channel) && TEXT_TYPES.has(channel.type);
const channelOf = (guild, id) => guild?.channels?.cache?.get?.(String(id)) ?? null;

/** The states in which the mirror runs, and so do the links it made. */
const RUNNING = new Set([PAIR_STATUS.COPYING, PAIR_STATUS.LIVE, PAIR_STATUS.DONE]);
export const mirrorRuns = (pair) => Boolean(pair) && RUNNING.has(pair.status);

/** The first linking of a pair is the one that may switch the Bridge module on; this id map entry says it happened. */
const MODULE_MARKER = ['bridge', 'module'];

const sleepReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An owner's member in their own server (null when it cannot be had). */
async function memberOf(guild, userId) {
  if (!guild || !userId) return null;
  try {
    return (
      guild.members?.cache?.get?.(String(userId)) ?? (await guild.members?.fetch?.(String(userId))) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Put a pair's links in step with the mirror: while it runs, the links it holds run again; otherwise they are
 * paused. Only links the mirror made are touched, and only those it paused itself are resumed.
 * @returns {Promise<{ held: number, resumed: number, waiting: string[] }>}
 */
export async function syncMirrorLinks(pairOrId) {
  const pair = typeof pairOrId === 'object' ? pairOrId : await getPair(Number(pairOrId));
  const out = { held: 0, resumed: 0, waiting: [] };
  if (!pair) return out;
  for (const row of await listMirrorLinks(pair.id)) {
    if (mirrorRuns(pair)) {
      const res = await resumeMirrorLink(row.linkId);
      if (res.resumed) out.resumed += 1;
      else if (res.reason) out.waiting.push(res.reason);
    } else if (await holdMirrorLink(row.linkId)) {
      out.held += 1;
    }
  }
  return out;
}

/**
 * The mirror is being removed by `side` ('source' the Discord server, 'target' the Fluxer server): its links stay,
 * paused by that server, so only its owner can resume them on the Bridge page and the other server's owner can
 * unlink them.
 */
export async function releaseMirrorLinks(pairId, side = '') {
  const linkSide = side === 'source' ? 'a' : side === 'target' ? 'b' : '';
  let released = 0;
  for (const row of await listMirrorLinks(pairId)) {
    if (await releaseMirrorLink(row.linkId, linkSide)) released += 1;
  }
  return released;
}

/**
 * Link every mirrored text channel pair that is not linked yet.
 * @param {number} pairId
 * @param {{ sleep?: (ms: number) => Promise<void>, limit?: number, skip?: Set<string>, open?: boolean }} [opts]
 *   `skip`: channels (Discord ids) an earlier run of the same step already tried, so a batch does not try them again;
 *   `open`: sign-in is off (the default follows the configuration), so there are no owners to check
 * @returns {Promise<{ linked: number, already: number, remaining: number, tried: string[], skipped: { sourceId: string, name: string, code: string, message: string }[], reason?: string }>}
 */
export async function linkMirroredChannels(
  pairId,
  { sleep = sleepReal, limit = LINKS_PER_RUN, skip = new Set(), open = !config.authEnabled } = {}
) {
  const none = (reason) => ({ linked: 0, already: 0, remaining: 0, tried: [], skipped: [], reason });
  const pair = await getPair(Number(pairId));
  if (!pair) return none('no-such-mirror');
  if (!mirrorRuns(pair)) return none('mirror-not-running');
  if (!runtime.clients.discord || !runtime.clients.fluxer) return none('bridge-not-available');

  const sg = guildByKey(pair.sourceGuild);
  const tg = guildByKey(pair.targetGuild);
  if (!sg || !tg) return none('server-missing');

  // The links the mirror holds go on again first (this is also how a "copy again" wakes them after a pause).
  await syncMirrorLinks(pair);

  const todo = [];
  const skipped = [];
  let already = 0;
  for (const m of await listMappings(pair.id, 'channel')) {
    if (m.removedAt > 0) continue;
    const src = channelOf(sg, m.sourceId);
    const dst = channelOf(tg, m.targetId);
    if (!isText(src) || !isText(dst)) continue; // voice, category, forum and the like are not bridged
    if (await getMirrorLink(pair.id, m.sourceId)) {
      already += 1;
      continue;
    }
    if (skip.has(m.sourceId)) continue;
    const found = await linkForChannel(pair.sourceGuild, m.sourceId);
    if (found) {
      const same =
        found.side === 'a' && found.link.guildB === pair.targetGuild && found.link.channelB === m.targetId;
      if (same && String(found.link.requestedBy).endsWith('(server mirror)')) {
        // A link this mirror made whose record was lost (a restart between the two writes): take it over.
        await putMirrorLink(pair.id, m.sourceId, m.targetId, found.link.id);
        already += 1;
      } else {
        // A link the owners made themselves is theirs: it is never taken over, and never changed.
        skipped.push({
          sourceId: m.sourceId,
          name: m.label || src.name,
          code: 'exists',
          message: same
            ? 'this pair is already bridged by hand, and the mirror leaves it as it is'
            : 'this channel is already bridged to another channel',
        });
      }
      continue;
    }
    todo.push({ sourceId: m.sourceId, targetId: m.targetId, name: m.label || src.name });
  }
  if (todo.length === 0) {
    const out = { linked: 0, already, remaining: 0, tried: [], skipped };
    return already || skipped.length ? out : { ...out, reason: 'nothing-to-link' };
  }

  // Only the first linking of a pair switches the Bridge module on. After that, a server that switched it off has
  // decided so (it is the switch for every bridge in that server), and the mirror does not switch it on again.
  if (await getMapping(pair.id, ...MODULE_MARKER)) {
    const off = [];
    for (const key of [pair.sourceGuild, pair.targetGuild]) {
      if (!(await isModuleEnabled(key, 'bridge'))) off.push(key);
    }
    if (off.length > 0) {
      for (const item of todo) {
        skipped.push({
          sourceId: item.sourceId,
          name: item.name,
          code: 'bridge-off',
          message: 'the Bridge module is switched off in one of the servers, and the mirror does not switch it on again',
        });
      }
      return { linked: 0, already, remaining: 0, tried: [], skipped, reason: 'bridge-off' };
    }
  } else {
    await enableBridgeForMirror(pair.sourceGuild);
    await enableBridgeForMirror(pair.targetGuild);
    await putMapping({
      pairId: pair.id,
      kind: MODULE_MARKER[0],
      sourceId: MODULE_MARKER[1],
      targetId: '',
      owned: false,
      specHash: '',
    });
  }

  // The owners who agreed must be able to see, read and send in each channel themselves (as for a link made by
  // hand). With sign-in off there is no one to check.
  const members = {
    source: open ? null : await memberOf(sg, pair.sourceConsentUser),
    target: open ? null : await memberOf(tg, pair.targetConsentUser),
  };
  const consent = {
    sourceBy: pair.sourceConsentBy,
    targetBy: pair.targetConsentBy,
    // The people who agreed to the mirror (the bridge's own owner check then pauses the link if a server changes hands).
    sourceOwner: pair.sourceConsentUser || String(sg.ownerId ?? ''),
    targetOwner: pair.targetConsentUser || String(tg.ownerId ?? ''),
  };

  let linked = 0;
  let attempted = 0;
  const tried = [];
  for (const item of todo) {
    if (attempted >= limit) break;
    attempted += 1;
    tried.push(item.sourceId);
    try {
      const link = await createMirrorLink({
        source: { guildKey: pair.sourceGuild, channelId: item.sourceId },
        target: { guildKey: pair.targetGuild, channelId: item.targetId },
        members,
        open,
        consent,
      });
      await putMirrorLink(pair.id, item.sourceId, item.targetId, link.id);
      linked += 1;
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err;
      log.info(
        'mirror',
        `pair ${pair.id}: ${item.name} not linked (${err.code || err.status}): ${err.message}`
      );
      skipped.push({
        sourceId: item.sourceId,
        name: item.name,
        code: err.code || 'refused',
        message: err.message,
      });
    }
    if (attempted < limit && attempted < todo.length) await sleep(PAUSE_BETWEEN_MS);
  }
  return { linked, already, remaining: Math.max(0, todo.length - attempted), tried, skipped };
}
