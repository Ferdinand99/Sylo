// The mirror engine: previews a copy, runs it from a queue and keeps the Fluxer server in step afterwards.
//
//   previewPair(pair)      the dry run: the plan and everything that cannot be carried over, nothing created
//   startCopy(pair)        turns the plan into queue jobs (src/db/mirror.js) and starts working them
//   runPair(pairId)        works one pair's queue: one job at a time, spaced out, backed off when Fluxer says
//                          so, and paused (with the reason) when it keeps failing
//   noteSourceChange(...)  a change on Discord (a channel renamed, a role deleted ...) becomes a job
//   tick()                 what the timer calls: starts a worker for every pair with work to do
//
// Rules the code below keeps:
//   - Discord is the source and is only ever read. Fluxer is written to, and only through the id map: a
//     Fluxer item is deleted only when Sylo created it (`owned`) and its Discord original is gone.
//   - A job names an item, not a payload. It reads the item as it is when it runs, so a stale job never
//     writes old data, and a burst of events about one item is one job.
//   - Each pair has its own worker, its own spacing and its own failure count: one pair going wrong
//     never slows or stops another.
//   - The queue is in the database. After a restart the unfinished jobs are still there; a job that was running
//     when the process stopped is marked "recovering", and before it creates anything it looks for what the
//     dead run may already have made (and adopts it, never as something Sylo may delete).
import * as store from '../db/mirror.js';
import { getGuildModule, getGuildModules, setGuildModule } from '../db/modules.js';
import { recordAudit } from '../db/audit.js';
import { getModule } from '../modules/registry.js';
import { invalidateHealth } from '../lib/healthCache.js';
import { log } from '../lib/log.js';
import { allClientsReady, guildByKey } from '../platform/platformOf.js';
import { safeFetch } from '../lib/safeFetch.js';
import { requirePairConsent } from './consent.js';
import { linkMirroredChannels as defaultLink } from './bridgeLink.js';
import { MirrorError, classifyError } from './errors.js';
import { buildPlan, channelOrder, copiedSets } from './plan.js';
import { snapshotDiscordGuild, snapshotFluxerGuild } from './snapshot.js';
import { createFluxerTarget } from './target.js';
import {
  FLUXER_LIMITS,
  buildChannelSpec,
  buildEmojiSpec,
  buildIdentitySpec,
  buildRoleSpec,
  buildStickerSpec,
  normaliseOptions,
  placeholderConfig,
  refsIn,
  resolveSpec,
  roleSkipReason,
  specHash,
} from './spec.js';
import { keepFluxerOnly } from './permissions.js';

const { PAIR_STATUS } = store;
const KINDS_WITH_MAP = ['role', 'channel', 'emoji', 'sticker', 'guild', 'order', 'module'];
const SOURCE_LIST = { role: 'roles', channel: 'channels', emoji: 'emojis', sticker: 'stickers' };
/** After a reorder-worthy change, wait a little so one drag of many channels is one reorder. */
const REORDER_DELAY_MS = 3000;
const PRUNE_EVERY_MS = 60 * 60_000;
const KEEP_FINISHED_MS = 7 * 86_400_000;

const sleepReal = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** The default image download: only http(s), never a private address, never more than `maxBytes`. */
async function fetchImageReal(url, { maxBytes }) {
  const res = await safeFetch(url, { maxBytes, timeoutMs: 15_000, allowPrivate: false });
  if (!res.ok) throw new MirrorError(`The image could not be downloaded (HTTP ${res.status}).`, 'item');
  const type = String(res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim();
  const mime = /^image\/(png|gif|jpeg|webp)$/.test(type) ? type : sniffMime(res.body);
  return { bytes: res.body, mime };
}

function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 2 && buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 11 && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

/**
 * @param {Partial<{
 *   now: () => number, sleep: (ms: number) => Promise<void>, minIntervalMs: number, backoffBaseMs: number,
 *   maxBackoffMs: number, maxAttempts: number, pauseAfterFailures: number, jobBudgetMs: number,
 *   sourceGuild: (key: string) => any, targetGuild: (key: string) => any, makeTarget: (guild: any) => any,
 *   fetchImage: (url: string, opts: { maxBytes: number }) => Promise<{ bytes: Buffer, mime: string }>,
 *   clientsReady: () => boolean, linkMirroredChannels: (pairId: number) => Promise<{ linked: number, reason?: string }>,
 * }>} [overrides]
 */
export function createEngine(overrides = {}) {
  const deps = {
    now: () => Date.now(),
    sleep: sleepReal,
    minIntervalMs: 600,
    backoffBaseMs: 2000,
    maxBackoffMs: 5 * 60_000,
    maxAttempts: 8,
    pauseAfterFailures: 3,
    jobBudgetMs: 25_000,
    sourceGuild: (key) => guildByKey(key),
    targetGuild: (key) => guildByKey(key),
    makeTarget: createFluxerTarget,
    fetchImage: fetchImageReal,
    clientsReady: allClientsReady,
    linkMirroredChannels: defaultLink,
    ...overrides,
  };

  /** Pairs with a worker running right now: pair id -> promise. */
  const active = new Map();
  /** Per pair: kinds Fluxer refused as over a limit this run, and when it asked to wait. */
  const state = new Map();
  let lastPrune = 0;
  let stopped = false;

  const stateOf = (pairId) => {
    if (!state.has(pairId)) state.set(pairId, { limitReached: new Set(), blockedUntil: 0 });
    return state.get(pairId);
  };

  const touchHealth = (pair) => {
    invalidateHealth(pair.sourceGuild);
    invalidateHealth(pair.targetGuild);
  };

  // --- loading what a pair works on ------------------------------------------------------------------

  /** The two servers of a pair as the platforms know them, or why they are not there. */
  function guildsOf(pair) {
    const sg = deps.sourceGuild(pair.sourceGuild);
    const tg = deps.targetGuild(pair.targetGuild);
    return { sg, tg };
  }

  async function loadMappings(pairId) {
    const out = {};
    for (const kind of KINDS_WITH_MAP) {
      out[kind] = new Map((await store.listMappings(pairId, kind)).map((m) => [m.sourceId, m]));
    }
    return out;
  }

  async function loadModules(pair) {
    const rows = await getGuildModules(pair.sourceGuild);
    const target = await getGuildModules(pair.targetGuild);
    return {
      source: rows.map((m) => ({
        id: m.id,
        name: getModule(m.id)?.name ?? m.id,
        enabled: m.enabled,
        defaultEnabled: Boolean(getModule(m.id)?.defaultEnabled),
        config: m.config,
        ownerOnly: Boolean(getModule(m.id)?.ownerOnly),
      })),
      targetConfigured: new Set(
        target.filter((m) => Object.keys(m.config ?? {}).length > 0).map((m) => m.id)
      ),
    };
  }

  // --- the dry run -----------------------------------------------------------------------------------

  /**
   * What a copy would do right now. Reads both servers and the id map; creates and changes nothing.
   * @returns {Promise<{ ok: boolean, blockers: object[], warnings: object[], steps: object[], notes: object[], summary: object, target: object | null }>}
   */
  async function previewPair(pair) {
    const blockers = [];
    const warnings = [];
    const { sg, tg } = guildsOf(pair);
    if (!sg)
      blockers.push({
        code: 'source-missing',
        message: 'Sylo is not in the Discord server (or it is not connected right now).',
      });
    if (!tg)
      blockers.push({
        code: 'target-missing',
        message: 'Sylo is not in the Fluxer server (or it is not connected right now).',
      });
    if (!sg || !tg) return { ok: false, blockers, warnings, steps: [], notes: [], summary: {}, target: null };

    const target = deps.makeTarget(tg);
    const missing = target.missingPermissions();
    if (missing.length) {
      blockers.push({
        code: 'target-permissions',
        message: `Sylo needs ${missing.join(', ')} on the Fluxer server. Give Sylo's role Administrator there, or those permissions.`,
      });
    }
    const options = normaliseOptions(pair.options);
    const source = snapshotDiscordGuild(sg);
    const targetSnap = snapshotFluxerGuild(tg);
    const plan = buildPlan({
      source,
      target: targetSnap,
      mappings: await loadMappings(pair.id),
      options,
      modules: options.modules ? await loadModules(pair) : undefined,
      limits: target.limits(),
    });
    const existing = targetSnap.channels.length;
    if (existing > 0 && pair.copyRun === 0) {
      warnings.push({
        code: 'target-not-empty',
        message: `The Fluxer server already has ${existing} channel(s). Sylo leaves them as they are and never deletes anything it did not create.`,
      });
    }
    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      steps: plan.steps,
      notes: plan.notes,
      summary: plan.summary,
      target: { id: tg.id, name: targetSnap.name },
    };
  }

  // --- turning a plan into work ----------------------------------------------------------------------

  const JOB_OF_KIND = {
    guild: { op: 'sync', kind: 'guild' },
    role: { op: 'sync', kind: 'role' },
    'order-roles': { op: 'reorder', kind: 'roles' },
    channel: { op: 'sync', kind: 'channel' },
    'order-channels': { op: 'reorder', kind: 'channels' },
    emoji: { op: 'sync', kind: 'emoji' },
    sticker: { op: 'sync', kind: 'sticker' },
    module: { op: 'sync', kind: 'module' },
    bridge: { op: 'link', kind: 'bridge' },
  };

  /**
   * Start (or repeat) the copy of a pair that both servers have agreed to. The plan becomes jobs; the worker
   * does them. Throws a ConsentError when a side has not agreed, and a MirrorError when nothing can be done.
   */
  async function startCopy(pairId) {
    let pair = await requirePairConsent(pairId);
    if (![PAIR_STATUS.READY, PAIR_STATUS.LIVE, PAIR_STATUS.DONE].includes(pair.status)) {
      throw new MirrorError(`A mirror that is ${pair.status} cannot be copied now.`, 'item');
    }
    const preview = await previewPair(pair);
    if (!preview.ok) throw new MirrorError(preview.blockers.map((b) => b.message).join(' '), 'item');

    const run = pair.copyRun + 1;
    for (const step of preview.steps) {
      if (step.op === 'unchanged') continue;
      const job = JOB_OF_KIND[step.kind];
      await store.enqueueJob({
        pairId: pair.id,
        run,
        phase: 'copy',
        op: job.op,
        kind: job.kind,
        sourceId: step.sourceId,
        stepKey: `copy:${run}:${step.key}`,
        payload: {
          name: step.name,
          planned: step.op,
          ...(step.op === 'skip' ? { skip: step.reason ?? 'skipped', notes: step.notes ?? [] } : {}),
        },
        now: deps.now(),
      });
    }
    state.delete(pair.id);
    pair = await store.updatePair(
      pair.id,
      { status: PAIR_STATUS.COPYING, copyRun: run, lastError: '', failures: 0, resumeStatus: '' },
      deps.now()
    );
    touchHealth(pair);
    return pair;
  }

  // --- changes on Discord ----------------------------------------------------------------------------

  const KIND_OPTION = {
    role: 'roles',
    channel: 'channels',
    emoji: 'emoji',
    sticker: 'stickers',
    guild: 'name',
  };

  /**
   * A thing changed on the Discord server. Becomes a job when a mirror is running for that server and
   * continuous mirroring is on; otherwise nothing happens.
   * @param {string} sourceKey
   * @param {{ kind: 'role'|'channel'|'emoji'|'sticker'|'guild', op: 'sync'|'delete', id: string, reorder?: 'roles'|'channels' }} change
   * @returns {Promise<boolean>} whether work was queued
   */
  async function noteSourceChange(sourceKey, change) {
    const pair = await store.getPairBySource(sourceKey);
    if (!pair) return false;
    if (![PAIR_STATUS.COPYING, PAIR_STATUS.LIVE, PAIR_STATUS.PAUSED].includes(pair.status)) return false;
    const options = normaliseOptions(pair.options);
    if (!options.continuous) return false;
    if (
      change.kind === 'guild'
        ? !(options.name || options.icon || options.banner)
        : !options[KIND_OPTION[change.kind]]
    ) {
      return false;
    }
    const now = deps.now();
    let queued = false;
    if (change.op === 'delete') {
      // A delete replaces any change still waiting for the same item, and is only needed when Sylo made a copy.
      await store.skipWaitingJobs(pair.id, change.kind, change.id, 'sync', 'deleted on Discord', now);
      if (await store.getMapping(pair.id, change.kind, change.id)) {
        queued = await store.enqueueJob({
          pairId: pair.id,
          phase: 'sync',
          op: 'delete',
          kind: change.kind,
          sourceId: change.id,
          stepKey: `delete:${change.kind}:${change.id}`,
          now,
        });
      }
    } else {
      queued = await store.enqueueJob({
        pairId: pair.id,
        phase: 'sync',
        op: 'sync',
        kind: change.kind,
        sourceId: change.id,
        stepKey: `sync:${change.kind}:${change.id}`,
        now,
      });
    }
    if (change.reorder) {
      const orderOk = change.reorder === 'roles' ? options.roles : options.channels;
      if (orderOk) {
        queued =
          (await store.enqueueJob({
            pairId: pair.id,
            phase: 'sync',
            op: 'reorder',
            kind: change.reorder,
            sourceId: change.reorder,
            stepKey: `reorder:${change.reorder}`,
            now: now + REORDER_DELAY_MS,
          })) || queued;
      }
    }
    return queued;
  }

  // --- the work of one job ---------------------------------------------------------------------------

  /** What a job found or did. `remote`: it called Fluxer, so the worker waits before the next one. */
  const done = (detail, extra = {}) => ({ status: 'done', detail, notes: [], remote: false, ...extra });
  const skipped = (detail, extra = {}) => ({ status: 'skipped', detail, notes: [], remote: false, ...extra });

  const findSource = (ctx, kind, id) => ctx.source[SOURCE_LIST[kind]].find((x) => x.id === id) ?? null;

  /** Fluxer ids for the placeholders of a spec (making what is missing first), and the spec with them swapped in. */
  async function resolveFor(ctx, spec, depth) {
    for (const ref of refsIn(spec)) {
      const [kind, id] = ref.split(':');
      if (await store.getMapping(ctx.pair.id, kind, id)) continue;
      if (depth >= 3) continue;
      if (kind === 'role' && ctx.sets.copiedRoles.has(id)) await syncRole(ctx, id, depth + 1);
      if (kind === 'channel' && ctx.sets.copiedChannels.has(id)) await syncChannel(ctx, id, depth + 1);
    }
    const ids = new Map();
    for (const ref of refsIn(spec)) {
      const [kind, id] = ref.split(':');
      const m = await store.getMapping(ctx.pair.id, kind, id);
      if (m) ids.set(ref, m.targetId);
    }
    const everyone = await store.getMapping(ctx.pair.id, 'role', ctx.source.everyoneId);
    return resolveSpec(spec, (kind, id) =>
      kind === 'role' && id === 'everyone'
        ? (everyone?.targetId ?? ctx.target.id)
        : (ids.get(`${kind}:${id}`) ?? null)
    );
  }

  async function adoptable(ctx, kind, match) {
    const taken = new Set((await store.listMappings(ctx.pair.id, kind)).map((m) => m.targetId));
    const pool = {
      channel: ctx.target.listChannels(),
      role: ctx.target.listRoles(),
      emoji: ctx.target.listEmojis(),
      sticker: ctx.target.listStickers(),
    }[kind];
    return pool.find((x) => !taken.has(x.id) && match(x)) ?? null;
  }

  /** @everyone exists on both sides: Sylo adopts it (never owns it) and only sets its permissions. */
  async function syncEveryone(ctx, role) {
    const targetRole = snapshotFluxerGuild(ctx.targetGuild).roles.find((r) => r.isEveryone);
    const { spec, notes } = buildRoleSpec(role, { keep: keepFluxerOnly(targetRole?.permissions ?? 0n) });
    const hash = specHash(spec);
    const m = await store.getMapping(ctx.pair.id, 'role', role.id);
    if (m && m.specHash === hash) return done('unchanged', { notes });
    await ctx.target.editRole(ctx.target.id, spec);
    await store.putMapping({
      pairId: ctx.pair.id,
      kind: 'role',
      sourceId: role.id,
      targetId: ctx.target.id,
      owned: false,
      specHash: hash,
      now: deps.now(),
    });
    return done('@everyone permissions set', { notes, remote: true });
  }

  async function syncRole(ctx, roleId, depth = 0) {
    const role = findSource(ctx, 'role', roleId);
    if (!role) return skipped('the role is gone on Discord');
    if (role.isEveryone) return syncEveryone(ctx, role);
    if (!ctx.sets.copiedRoles.has(roleId)) return skipped(roleSkipReason(role) ?? 'roles are not copied');
    const { spec, notes } = buildRoleSpec(role);
    const hash = specHash(spec);
    const m = await store.getMapping(ctx.pair.id, 'role', roleId);
    const put = (targetId, owned) =>
      store.putMapping({
        pairId: ctx.pair.id,
        kind: 'role',
        sourceId: roleId,
        targetId,
        owned,
        specHash: hash,
        now: deps.now(),
      });
    if (m) {
      if (m.specHash === hash) return done('unchanged', { notes });
      try {
        await ctx.target.editRole(m.targetId, spec);
        await put(m.targetId, m.owned);
        return done('updated', { notes, remote: true });
      } catch (err) {
        if (classifyError(err).kind !== 'gone') throw err;
        await store.deleteMapping(ctx.pair.id, 'role', roleId); // deleted on Fluxer: make it again
      }
    }
    if (ctx.job?.recovering && depth === 0) {
      const found = await adoptable(
        ctx,
        'role',
        (r) => r.name === spec.name && !r.managed && r.id !== ctx.target.id
      );
      if (found) {
        await ctx.target.editRole(found.id, spec);
        await put(found.id, false);
        return done('adopted what an interrupted run made', { notes, remote: true });
      }
    }
    await put(await ctx.target.createRole(spec), true);
    return done('created', { notes, remote: true });
  }

  async function syncChannel(ctx, channelId, depth = 0) {
    const ch = findSource(ctx, 'channel', channelId);
    if (!ch) return skipped('the channel is gone on Discord');
    const built = buildChannelSpec(ch, { source: ctx.source, copiedRoles: ctx.sets.copiedRoles });
    if (!built.spec) return skipped('no such channel type on Fluxer', { notes: built.notes });
    if (!ctx.sets.copiedChannels.has(channelId))
      return skipped('channels are not copied', { notes: built.notes });
    const hash = specHash(built.spec);
    const m = await store.getMapping(ctx.pair.id, 'channel', channelId);
    if (m && m.specHash === hash) return done('unchanged', { notes: built.notes });

    const { value, unresolved } = await resolveFor(ctx, built.spec, depth);
    value.permissionOverwrites = (value.permissionOverwrites ?? []).filter((o) => o.id);
    const notes = [...built.notes];
    for (const ref of unresolved) {
      notes.push({
        code: 'dependency-missing',
        scope: 'channel',
        ref: { kind: 'channel', id: ch.id, name: ch.name },
        message: `${ch.name}: ${ref.replace(':', ' ')} could not be made on Fluxer, so a link to it is left out.`,
      });
    }
    const put = (targetId, owned) =>
      store.putMapping({
        pairId: ctx.pair.id,
        kind: 'channel',
        sourceId: channelId,
        targetId,
        owned,
        specHash: hash,
        now: deps.now(),
      });
    if (m) {
      try {
        await ctx.target.editChannel(m.targetId, value);
        await put(m.targetId, m.owned);
        return done('updated', { notes, remote: true });
      } catch (err) {
        if (classifyError(err).kind !== 'gone') throw err;
        await store.deleteMapping(ctx.pair.id, 'channel', channelId);
      }
    }
    if (ctx.job?.recovering && depth === 0) {
      const found = await adoptable(
        ctx,
        'channel',
        (c) =>
          c.name === value.name && c.type === value.type && (c.parentId ?? null) === (value.parentId ?? null)
      );
      if (found) {
        await ctx.target.editChannel(found.id, value);
        await put(found.id, false);
        return done('adopted what an interrupted run made', { notes, remote: true });
      }
    }
    await put(await ctx.target.createChannel(value), true);
    return done('created', { notes, remote: true });
  }

  /** Download an image for an emoji or sticker; null (with a note) when it is too big. */
  async function download(ctx, item, maxBytes, code, kind) {
    if (!item.url) return { note: noteFor(code, kind, item, 'it has no image to copy') };
    try {
      return { image: await deps.fetchImage(item.url, { maxBytes }) };
    } catch (err) {
      if (/too large|over \d+ bytes/i.test(String(err?.message))) {
        return {
          note: noteFor(
            code,
            kind,
            item,
            `it is bigger than ${Math.round(maxBytes / 1024)} KB, the most Fluxer takes`
          ),
        };
      }
      throw err;
    }
  }
  const noteFor = (code, kind, item, why) => ({
    code,
    scope: kind,
    ref: { kind, id: item.id, name: item.name },
    message: `${item.name}: ${why}, so it is not copied.`,
  });

  async function syncExpression(ctx, kind, id) {
    const item = findSource(ctx, kind, id);
    if (!item) return skipped(`the ${kind} is gone on Discord`);
    const built = kind === 'emoji' ? buildEmojiSpec(item) : buildStickerSpec(item);
    if (!built.spec) return skipped('not supported on Fluxer', { notes: built.notes });
    if (kind === 'emoji' && item.managed) return skipped('managed by an integration');
    const hash = specHash(built.spec);
    const m = await store.getMapping(ctx.pair.id, kind, id);
    if (m && m.specHash === hash) return done('unchanged', { notes: built.notes });
    const put = (targetId, owned) =>
      store.putMapping({
        pairId: ctx.pair.id,
        kind,
        sourceId: id,
        targetId,
        owned,
        specHash: hash,
        now: deps.now(),
      });
    const limits = ctx.target.limits();
    if (m) {
      try {
        if (kind === 'emoji') await ctx.target.editEmoji(m.targetId, built.spec);
        else await ctx.target.editSticker(m.targetId, built.spec);
        await put(m.targetId, m.owned);
        return done('updated', { notes: built.notes, remote: true });
      } catch (err) {
        if (classifyError(err).kind !== 'gone') throw err;
        await store.deleteMapping(ctx.pair.id, kind, id);
      }
    }
    if (stateOf(ctx.pair.id).limitReached.has(kind)) {
      return skipped('Fluxer is full', {
        notes: [noteFor(`${kind}-limit`, kind, item, 'Fluxer has no room for more')],
      });
    }
    if (ctx.job?.recovering) {
      const found = await adoptable(ctx, kind, (x) => x.name === built.spec.name);
      if (found) {
        await put(found.id, false);
        return done('adopted what an interrupted run made', { notes: built.notes });
      }
    }
    const maxBytes = kind === 'emoji' ? limits.emojiBytes : limits.stickerBytes;
    const got = await download(ctx, item, maxBytes, `${kind}-too-large`, kind);
    if (got.note) return skipped('image not copied', { notes: [got.note] });
    try {
      const targetId =
        kind === 'emoji'
          ? await ctx.target.createEmoji({ name: built.spec.name, image: got.image })
          : await ctx.target.createSticker({ ...built.spec, image: got.image });
      await put(targetId, true);
      return done('created', { notes: built.notes, remote: true });
    } catch (err) {
      if (classifyError(err).kind !== 'limit') throw err;
      stateOf(ctx.pair.id).limitReached.add(kind);
      return skipped('Fluxer is full', {
        notes: [noteFor(`${kind}-limit`, kind, item, 'Fluxer refused it as over its limit')],
        remote: true,
      });
    }
  }

  async function syncIdentity(ctx) {
    const options = ctx.options;
    const { spec } = buildIdentitySpec(ctx.source, options);
    const hash = specHash(spec);
    const m = await store.getMapping(ctx.pair.id, 'guild', 'identity');
    if (m && m.specHash === hash) return done('unchanged');
    const body = {};
    const notes = [];
    if (spec.name) body.name = spec.name;
    for (const key of ['icon', 'banner']) {
      // Discord has none: leave whatever the Fluxer server has.
      if (!spec[key]) continue;
      const got = await download(
        ctx,
        { id: key, name: key, url: spec[key] },
        8 * 1024 * 1024,
        `${key}-too-large`,
        'guild'
      );
      if (got.note) notes.push(got.note);
      else body[key] = `data:${got.image.mime};base64,${got.image.bytes.toString('base64')}`;
    }
    if (Object.keys(body).length) await ctx.target.editGuild(body);
    await store.putMapping({
      pairId: ctx.pair.id,
      kind: 'guild',
      sourceId: 'identity',
      targetId: ctx.target.id,
      owned: false,
      specHash: hash,
      now: deps.now(),
    });
    return done('updated', { notes, remote: Object.keys(body).length > 0 });
  }

  async function syncModule(ctx, moduleId) {
    const def = getModule(moduleId);
    if (!def || def.ownerOnly) return skipped('not copied');
    const source = await getGuildModule(ctx.pair.sourceGuild, moduleId);
    const mapped = await store.getMapping(ctx.pair.id, 'module', moduleId);
    const there = await getGuildModule(ctx.pair.targetGuild, moduleId);
    if (!mapped && Object.keys(there.config ?? {}).length > 0)
      return skipped('already set up on the Fluxer server');
    const { config, dropped, cleared } = placeholderConfig(source.config ?? {}, {
      channels: ctx.sets.copiedChannels,
      roles: ctx.sets.copiedRoles,
      skippedChannels: ctx.sets.skippedChannels,
      skippedRoles: ctx.sets.skippedRoles,
    });
    const spec = { enabled: source.enabled, config };
    const hash = specHash(spec);
    if (mapped && mapped.specHash === hash) return done('unchanged');
    const { value } = await resolveFor(ctx, spec, 0);
    await setGuildModule(ctx.pair.targetGuild, moduleId, {
      enabled: Boolean(value.enabled),
      config: value.config ?? {},
    });
    await recordAudit(ctx.pair.targetGuild, {
      actor: 'Sylo (mirror)',
      action: 'mirror:module',
      detail: `${def.name} copied from the Discord server`,
    });
    await store.putMapping({
      pairId: ctx.pair.id,
      kind: 'module',
      sourceId: moduleId,
      targetId: moduleId,
      owned: false,
      specHash: hash,
      now: deps.now(),
    });
    const notes = [];
    if (dropped || cleared) {
      notes.push({
        code: 'module-ids-dropped',
        scope: 'module',
        ref: { kind: 'module', id: moduleId, name: def.name },
        message: `${def.name}: ${dropped} channel or role setting(s) point at something that is not copied and ${cleared} message id(s) are cleared; set them again on the Fluxer server.`,
      });
    }
    return done('copied', { notes });
  }

  async function reorder(ctx, which) {
    if (which === 'roles') {
      const order = ctx.source.roles
        .filter((r) => ctx.sets.copiedRoles.has(r.id))
        .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
        .map((r) => r.id);
      const hash = specHash(order);
      const m = await store.getMapping(ctx.pair.id, 'order', 'roles');
      if (m && m.specHash === hash) return done('unchanged');
      const top = ctx.target.topPosition();
      const updates = [];
      for (const [i, id] of order.entries()) {
        const mapping = await store.getMapping(ctx.pair.id, 'role', id);
        if (!mapping) continue;
        updates.push({
          id: mapping.targetId,
          position: top == null ? i + 1 : Math.min(i + 1, Math.max(1, top - 1)),
        });
      }
      const notes = [];
      if (top != null && order.length > top - 1) {
        notes.push({
          code: 'roles-above-sylo',
          scope: 'role',
          ref: { kind: 'role', id: 'order', name: 'Role order' },
          message:
            "Sylo's role on the Fluxer server is too low to order every role as on Discord. Move Sylo's role higher there.",
        });
      }
      if (updates.length > 1) await ctx.target.setRolePositions(updates);
      await store.putMapping({
        pairId: ctx.pair.id,
        kind: 'order',
        sourceId: 'roles',
        targetId: '',
        owned: false,
        specHash: hash,
        now: deps.now(),
      });
      return done(`${updates.length} roles ordered`, { notes, remote: updates.length > 1 });
    }
    const layout = channelOrder(ctx.source, ctx.sets.copiedChannels);
    const hash = specHash(layout);
    const m = await store.getMapping(ctx.pair.id, 'order', 'channels');
    if (m && m.specHash === hash) return done('unchanged');
    const updates = [];
    for (const item of layout) {
      const mapping = await store.getMapping(ctx.pair.id, 'channel', item.id);
      if (!mapping) continue;
      const parent = item.parentId ? await store.getMapping(ctx.pair.id, 'channel', item.parentId) : null;
      updates.push({ id: mapping.targetId, position: item.position, parentId: parent?.targetId ?? null });
    }
    if (updates.length > 1) await ctx.target.setChannelPositions(updates);
    await store.putMapping({
      pairId: ctx.pair.id,
      kind: 'order',
      sourceId: 'channels',
      targetId: '',
      owned: false,
      specHash: hash,
      now: deps.now(),
    });
    return done(`${updates.length} channels ordered`, { remote: updates.length > 1 });
  }

  /** Delete the Fluxer copy of something deleted on Discord: only what Sylo created, never anything else. */
  async function deleteCopy(ctx, kind, sourceId) {
    const m = await store.getMapping(ctx.pair.id, kind, sourceId);
    if (!m) return skipped('Sylo has no copy of it');
    if (!m.owned) {
      await store.deleteMapping(ctx.pair.id, kind, sourceId);
      return skipped('Sylo did not create it on Fluxer, so it is left alone');
    }
    const method = {
      role: 'deleteRole',
      channel: 'deleteChannel',
      emoji: 'deleteEmoji',
      sticker: 'deleteSticker',
    }[kind];
    if (!method) return skipped('nothing to delete');
    try {
      await ctx.target[method](m.targetId);
    } catch (err) {
      if (classifyError(err).kind !== 'gone') throw err;
    }
    await store.deleteMapping(ctx.pair.id, kind, sourceId);
    return done('deleted', { remote: true });
  }

  async function perform(ctx, job) {
    if (job.payload?.skip) return skipped(String(job.payload.skip), { notes: job.payload.notes ?? [] });
    if (job.op === 'delete') return deleteCopy(ctx, job.kind, job.sourceId);
    if (job.op === 'reorder') return reorder(ctx, job.kind);
    if (job.op === 'link') {
      const res = await deps.linkMirroredChannels(ctx.pair.id);
      return done(
        res.linked > 0 ? `${res.linked} channels linked` : `not linked: ${res.reason ?? 'nothing to link'}`
      );
    }
    switch (job.kind) {
      case 'guild':
        return syncIdentity(ctx);
      case 'role':
        return syncRole(ctx, job.sourceId);
      case 'channel':
        return syncChannel(ctx, job.sourceId);
      case 'emoji':
      case 'sticker':
        return syncExpression(ctx, job.kind, job.sourceId);
      case 'module':
        return syncModule(ctx, job.sourceId);
      default:
        return skipped('unknown step');
    }
  }

  // --- the worker --------------------------------------------------------------------------------------

  async function pausePair(pair, message) {
    const next = await store.updatePair(
      pair.id,
      {
        status: PAIR_STATUS.PAUSED,
        resumeStatus: pair.status === PAIR_STATUS.PAUSED ? pair.resumeStatus : pair.status,
        lastError: String(message).slice(0, 300),
      },
      deps.now()
    );
    touchHealth(next);
    log.warn('mirror', `pair ${pair.id} paused: ${message}`);
    return next;
  }

  const backoffMs = (attempts) =>
    Math.min(deps.maxBackoffMs, deps.backoffBaseMs * 2 ** Math.max(0, attempts - 1));

  /** Do one job and record what happened. Returns whether Fluxer was called. */
  async function runJob(pair, ctx, job) {
    const s = stateOf(pair.id);
    try {
      const jobCtx = { ...ctx, job, source: snapshotDiscordGuild(ctx.sg) };
      jobCtx.sets = copiedSets(jobCtx.source, ctx.options);
      const res = await perform(jobCtx, job);
      await store.finishJob(job.id, res.status, res.detail, res.notes, deps.now());
      if (pair.failures > 0) pair = await store.updatePair(pair.id, { failures: 0 }, deps.now());
      return { pair, remote: res.remote };
    } catch (err) {
      const c = classifyError(err);
      const now = deps.now();
      if (c.kind === 'rate-limit') {
        s.blockedUntil = now + c.retryAfterMs;
        await store.retryJob(job.id, job.attempts, now + c.retryAfterMs, 'Fluxer asked to slow down', now);
        return { pair, remote: false };
      }
      if (c.kind === 'transient') {
        const attempts = job.attempts + 1;
        if (attempts >= deps.maxAttempts) {
          await store.finishJob(job.id, 'failed', c.message, [], now);
        } else {
          await store.retryJob(job.id, attempts, now + backoffMs(attempts), c.message, now);
        }
      } else {
        await store.finishJob(job.id, 'failed', c.message, [], now);
      }
      // Only trouble that is not about one item counts toward pausing the pair.
      if (c.kind === 'transient' || c.kind === 'permission') {
        const failures = pair.failures + 1;
        pair = await store.updatePair(pair.id, { failures, lastError: c.message.slice(0, 300) }, now);
        if (failures >= deps.pauseAfterFailures) {
          pair = await pausePair(
            pair,
            c.kind === 'permission'
              ? `Fluxer refused Sylo: ${c.message}. Check Sylo's permissions on the Fluxer server, then resume.`
              : `Fluxer could not be reached: ${c.message}`
          );
        }
      }
      return { pair, remote: true };
    }
  }

  /** The copy is complete when no copy job is left waiting or running. */
  async function maybeFinishCopy(pair) {
    if (pair.status !== PAIR_STATUS.COPYING) return pair;
    if ((await store.openCopyCount(pair.id, pair.copyRun)) > 0) return pair;
    const options = normaliseOptions(pair.options);
    const next = await store.updatePair(
      pair.id,
      { status: options.continuous ? PAIR_STATUS.LIVE : PAIR_STATUS.DONE, copiedAt: deps.now() },
      deps.now()
    );
    touchHealth(next);
    return next;
  }

  /**
   * Work one pair's queue until nothing is due, the pair stops being active, or `maxJobs` is reached.
   * Only one worker runs per pair at a time.
   * @returns {Promise<{ ran: number }>}
   */
  async function runPair(pairId, { maxJobs = Infinity } = {}) {
    if (active.has(pairId)) return { ran: 0 };
    const worker = (async () => {
      let ran = 0;
      while (ran < maxJobs && !stopped) {
        let pair = await store.getPair(pairId);
        if (!pair || ![PAIR_STATUS.COPYING, PAIR_STATUS.LIVE].includes(pair.status)) break;
        try {
          await requirePairConsent(pair);
        } catch (err) {
          await pausePair(pair, err.message);
          break;
        }
        const now = deps.now();
        if (stateOf(pairId).blockedUntil > now) break;

        const { sg, tg } = guildsOf(pair);
        if (!sg || !tg) {
          // A platform still connecting is not a reason to stop: wait. Once everything is up, a missing server is.
          if (!deps.clientsReady()) break;
          await pausePair(pair, `Sylo is no longer in the ${sg ? 'Fluxer' : 'Discord'} server.`);
          break;
        }
        const job = await store.nextDueJob(pairId, now);
        if (!job) {
          await maybeFinishCopy(pair);
          break;
        }
        if (!(await store.claimJob(job.id, now))) continue;
        const ctx = {
          pair,
          sg,
          targetGuild: tg,
          target: deps.makeTarget(tg),
          options: normaliseOptions(pair.options),
        };
        const out = await runJob(pair, ctx, job);
        ran += 1;
        if (out.remote) await deps.sleep(deps.minIntervalMs);
      }
      return { ran };
    })();
    active.set(pairId, worker);
    try {
      return await worker;
    } finally {
      active.delete(pairId);
    }
  }

  // --- the timer -------------------------------------------------------------------------------------

  /** Start a worker for every pair that has work. Does not wait for them (see stop()). */
  async function tick() {
    if (stopped) return;
    const now = deps.now();
    if (now - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now;
      await store.pruneMirrorJobs({ before: now - KEEP_FINISHED_MS });
    }
    for (const status of [PAIR_STATUS.COPYING, PAIR_STATUS.LIVE]) {
      for (const pair of await store.listPairsIn(status)) {
        if (active.has(pair.id)) continue;
        const due = await store.nextDueAt(pair.id);
        if (due === null && pair.status === PAIR_STATUS.LIVE) continue;
        runPair(pair.id).catch((err) => log.error('mirror', `worker for pair ${pair.id} failed:`, err));
      }
    }
  }

  /** After a restart: work that was in flight waits again, marked so it looks for what it may have made. */
  async function resumeAfterRestart() {
    await store.recoverRunningJobs(deps.now());
  }

  /** Stop taking new work and wait (briefly) for the workers that are running. */
  async function stop() {
    stopped = true;
    await Promise.race([Promise.allSettled([...active.values()]), deps.sleep(3000)]);
  }

  // --- what an admin can do ---------------------------------------------------------------------------

  async function pause(pairId) {
    const pair = await store.getPair(pairId);
    if (!pair || ![PAIR_STATUS.COPYING, PAIR_STATUS.LIVE].includes(pair.status)) {
      throw new MirrorError('Only a running mirror can be paused.', 'item');
    }
    const next = await store.updatePair(
      pairId,
      { status: PAIR_STATUS.PAUSED, resumeStatus: pair.status, lastError: '' },
      deps.now()
    );
    touchHealth(next);
    return next;
  }

  async function resume(pairId) {
    const pair = await store.getPair(pairId);
    if (!pair || pair.status !== PAIR_STATUS.PAUSED)
      throw new MirrorError('Only a paused mirror can be resumed.', 'item');
    await requirePairConsent(pair);
    state.delete(pairId);
    const next = await store.updatePair(
      pairId,
      { status: pair.resumeStatus || PAIR_STATUS.LIVE, resumeStatus: '', lastError: '', failures: 0 },
      deps.now()
    );
    touchHealth(next);
    return next;
  }

  /** End the mirror from either side. The id map stays, so asking again picks up where it left off. */
  async function stopPair(pairId) {
    const pair = await store.getPair(pairId);
    if (!pair) throw new MirrorError('There is no such mirror.', 'item');
    await store.dropOpenJobs(pairId, 'the mirror was stopped', deps.now());
    const next = await store.updatePair(
      pairId,
      {
        status: PAIR_STATUS.STOPPED,
        resumeStatus: '',
        codeHash: '',
        codeExpiresAt: 0,
        sourceConsentBy: '',
        sourceConsentAt: 0,
        targetConsentBy: '',
        targetConsentAt: 0,
      },
      deps.now()
    );
    state.delete(pairId);
    touchHealth(next);
    return next;
  }

  /** Forget the mirror altogether: the pair, its id map and its queue. Nothing on either server is touched. */
  async function removePair(pairId) {
    const pair = await store.getPair(pairId);
    if (!pair) return false;
    if ([PAIR_STATUS.COPYING, PAIR_STATUS.LIVE].includes(pair.status)) {
      throw new MirrorError('Stop the mirror before removing it.', 'item');
    }
    await store.deletePair(pairId);
    state.delete(pairId);
    touchHealth(pair);
    return true;
  }

  // --- what the dashboard shows ------------------------------------------------------------------------

  /** How far a pair is: the copy's jobs by state, and the changes still waiting. */
  async function progress(pair) {
    const counts = await store.jobCounts(pair.id, pair.copyRun, 'copy');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const finished = counts.done + counts.skipped + counts.failed;
    return {
      run: pair.copyRun,
      total,
      done: counts.done,
      skipped: counts.skipped,
      failed: counts.failed,
      waiting: counts.pending + counts.running,
      percent: total === 0 ? 0 : Math.round((finished / total) * 100),
      waitingChanges: await store.openSyncCount(pair.id),
    };
  }

  /** The report of the latest copy: every step and what became of it, and what could not be carried over. */
  async function report(pair, { limit = 2000 } = {}) {
    const jobs = await store.listRunJobs(pair.id, pair.copyRun, { limit });
    const items = jobs.map((j) => ({
      kind: j.kind,
      op: j.op,
      sourceId: j.sourceId,
      name: j.payload?.name ?? j.sourceId,
      planned: j.payload?.planned ?? null,
      status: j.status,
      detail: j.detail,
    }));
    const notes = jobs.flatMap((j) => j.notes);
    const link = jobs.find((j) => j.op === 'link');
    return {
      run: pair.copyRun,
      items,
      notes,
      failed: items.filter((i) => i.status === 'failed'),
      bridge: link ? { status: link.status, detail: link.detail } : null,
      summary: summariseJobs(jobs),
    };
  }

  return {
    deps,
    previewPair,
    startCopy,
    noteSourceChange,
    runPair,
    tick,
    resumeAfterRestart,
    stop,
    pause,
    resume,
    stopPair,
    removePair,
    progress,
    report,
    isRunning: (pairId) => active.has(pairId),
    /** For tests: forget the in-memory state (limits reached, backoff). */
    resetState: () => state.clear(),
    limits: FLUXER_LIMITS,
  };
}

/** Counts of a run's jobs per kind and result. */
function summariseJobs(jobs) {
  const out = {};
  for (const j of jobs) {
    out[j.kind] ??= { done: 0, skipped: 0, failed: 0, pending: 0, running: 0 };
    out[j.kind][j.status] += 1;
  }
  return out;
}
