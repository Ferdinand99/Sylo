// The plan of a copy: every step the mirror would take to make the Fluxer server match the Discord one, in
// the order it takes them, with what each would send and everything that cannot be carried over.
//
// buildPlan() is pure: snapshots and the id map in, steps out. The dry run shows the plan; the real copy
// turns the same plan into queue jobs, and each job rebuilds its spec with the same builders from the server as
// it is at that moment. So the preview and the copy agree by construction, and a server that changed in
// between simply gets the newer spec.
import {
  FLUXER_LIMITS,
  buildChannelSpec,
  buildEmojiSpec,
  buildIdentitySpec,
  buildRoleSpec,
  buildStickerSpec,
  placeholderConfig,
  roleSkipReason,
  specHash,
} from './spec.js';
import { DISCORD_CHANNEL } from './snapshot.js';
import { isElevated, keepFluxerOnly } from './permissions.js';
import { moduleGrantSites } from '../web/middleware/roleGrants.js';

/**
 * Modules whose settings are never copied: the ones that hold the operator's own keys (ownerOnly), and the bridge,
 * which has link state of its own. Every other module of the registry is copied; a test fails when a new module
 * is neither, so each new module is decided on purpose.
 */
export const NOT_COPIED_MODULES = Object.freeze(['apple-connect', 'bridge']);

/**
 * The settings of one module as they go to Fluxer, with the same checks the dashboard makes when someone saves them:
 * a role that gives powerful permissions is not handed out by the copied settings (autoroles, reaction roles, level
 * rewards, the verified or birthday role, command actions), and a giveaway that pings @here or @everyone is copied
 * at the lowest level. Anything dropped is a note, so the preview and the report say so.
 * @param {{ id: string, name: string, enabled: boolean, config: object }} mod
 * @param {{ copiedRoles: Set<string>, skippedRoles: Set<string>, copiedChannels: Set<string>, skippedChannels: Set<string> }} sets
 * @param {any} source  the Discord server snapshot
 */
export function buildModuleSpec(mod, sets, source) {
  const notes = [];
  const ref = { kind: 'module', id: mod.id, name: mod.name };
  const grants = new Set(
    moduleGrantSites(mod.id, mod.config ?? {})
      .map((g) => g.roleId)
      .filter(Boolean)
  );
  const elevated = new Set();
  for (const id of grants) {
    const role = source.roles.find((r) => r.id === id);
    if (role && isElevated(role.permissions)) elevated.add(id);
  }
  for (const id of elevated) {
    const role = source.roles.find((r) => r.id === id);
    notes.push({
      code: 'module-grant-dropped',
      scope: 'module',
      ref,
      message: `${mod.name}: the role ${role.name} gives powerful permissions, so the copied settings do not hand it out. Set it up on the Fluxer server yourself if you want it.`,
    });
  }
  const out = placeholderConfig(mod.config ?? {}, {
    channels: sets.copiedChannels,
    roles: new Set([...sets.copiedRoles].filter((id) => !elevated.has(id))),
    skippedChannels: sets.skippedChannels,
    skippedRoles: new Set([...sets.skippedRoles, ...elevated]),
  });
  const config = out.config;
  if (mod.id === 'giveaways' && (config.ping === 'here' || config.ping === 'everyone')) {
    config.ping = 'none';
    notes.push({
      code: 'module-ping-lowered',
      scope: 'module',
      ref,
      message: `${mod.name}: pinging @here or @everyone is not copied; it is off on the Fluxer server.`,
    });
  }
  if (out.dropped || out.cleared) {
    notes.push({
      code: 'module-ids-dropped',
      scope: 'module',
      ref,
      message: `${mod.name}: ${out.dropped} channel or role setting(s) point at something that is not copied and ${out.cleared} other id(s) (messages, members) are cleared; set them again on the Fluxer server.`,
    });
  }
  // The dashboard's funding guard (a copied economy that raises income from nothing) is not reproduced, so the economy
  // comes over switched off: its owner looks at the shop and the income settings, then turns it on.
  let enabled = mod.enabled;
  if (mod.id === 'economy' && enabled) {
    enabled = false;
    notes.push({
      code: 'module-economy-off',
      scope: 'module',
      ref,
      message: `${mod.name}: it is copied switched off. Look at the income settings and the shop on the Fluxer server, then switch it on.`,
    });
  }
  return { spec: { enabled, config }, notes, remapped: out.remapped };
}

/** The kinds of step, in the order the copy runs them. */
export const STEP_KINDS = Object.freeze([
  'guild',
  'role',
  'order-roles',
  'channel',
  'order-channels',
  'emoji',
  'sticker',
  'module',
  'bridge',
]);

/**
 * @typedef {Object} Step
 * @property {string} key        "<kind>:<discord id>", unique in a plan
 * @property {string} kind       one of STEP_KINDS
 * @property {string} sourceId   the Discord id (or a fixed name for the steps that are not one thing)
 * @property {string} name       what to show
 * @property {'create'|'update'|'unchanged'|'skip'} op
 * @property {string} [reason]   why a step is skipped
 * @property {object|null} spec  what would be sent (placeholders for ids, see spec.js)
 * @property {string} hash       fingerprint of the spec
 * @property {object[]} notes    what cannot be carried over
 */

const mappingOf = (mappings, kind, sourceId) => mappings?.[kind]?.get?.(sourceId);

function decide(mappings, kind, sourceId, hash) {
  const m = mappingOf(mappings, kind, sourceId);
  if (!m) return 'create';
  return m.specHash === hash ? 'unchanged' : 'update';
}

/**
 * Which Discord roles and channels a copy takes along, and which it leaves out (a managed role, a channel type
 * Fluxer lacks, everything of a kind the admin turned off).
 */
export function copiedSets(source, options) {
  const copiedRoles = new Set();
  const skippedRoles = new Set();
  for (const role of source.roles) {
    if (role.isEveryone) continue;
    if (options.roles && !roleSkipReason(role)) copiedRoles.add(role.id);
    else skippedRoles.add(role.id);
  }
  const copiedChannels = new Set();
  const skippedChannels = new Set();
  for (const ch of source.channels) {
    const { spec } = buildChannelSpec(ch, { source, copiedRoles });
    if (options.channels && spec) copiedChannels.add(ch.id);
    else skippedChannels.add(ch.id);
  }
  return { copiedRoles, skippedRoles, copiedChannels, skippedChannels };
}

/** For something that always exists on Fluxer already (the server itself, @everyone): update, never create. */
function existing(mappings, kind, sourceId, hash) {
  const op = decide(mappings, kind, sourceId, hash);
  return op === 'create' ? 'update' : op;
}

/** Order roles and channels the way they sit on the source: by position, then id for a stable tie. */
const byPosition = (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * @param {{
 *   source: ReturnType<import('./snapshot.js').snapshotDiscordGuild>,
 *   target?: ReturnType<import('./snapshot.js').snapshotFluxerGuild> | null,
 *   mappings?: Record<string, Map<string, { targetId: string, specHash: string, owned: boolean }>>,
 *   options: import('./spec.js').DEFAULT_OPTIONS,
 *   modules?: { source: Array<{ id: string, name: string, enabled: boolean, defaultEnabled?: boolean, config: object, ownerOnly?: boolean }>, targetConfigured: Set<string> },
 *   limits?: typeof FLUXER_LIMITS,
 * }} input
 * @returns {{ steps: Step[], notes: object[], summary: Record<string, Record<string, number>> }}
 */
export function buildPlan({
  source,
  target = null,
  mappings = {},
  options,
  modules,
  limits = FLUXER_LIMITS,
}) {
  /** @type {Step[]} */
  const steps = [];
  const push = (step) => steps.push({ reason: undefined, notes: [], ...step });

  const { copiedRoles, skippedRoles, copiedChannels, skippedChannels } = copiedSets(source, options);

  // 1. the server's own name, icon and banner
  if (options.name || options.icon || options.banner) {
    const { spec, notes } = buildIdentitySpec(source, options);
    const hash = specHash(spec);
    push({
      key: 'guild:identity',
      kind: 'guild',
      sourceId: 'identity',
      name: 'Server name, icon and banner',
      op: existing(mappings, 'guild', 'identity', hash),
      spec,
      hash,
      notes,
    });
  }

  // 2. roles, lowest first, then their order
  if (options.roles) {
    const everyone = source.roles.find((r) => r.isEveryone);
    if (everyone) {
      const keep = keepFluxerOnly(target?.roles?.find((r) => r.isEveryone)?.permissions ?? 0n);
      const { spec, notes } = buildRoleSpec(everyone, { keep });
      const hash = specHash(spec);
      push({
        key: `role:${everyone.id}`,
        kind: 'role',
        sourceId: everyone.id,
        name: '@everyone',
        op: existing(mappings, 'role', everyone.id, hash),
        spec,
        hash,
        notes,
      });
    }
    for (const role of [...source.roles].filter((r) => !r.isEveryone).sort(byPosition)) {
      if (!copiedRoles.has(role.id)) {
        push({
          key: `role:${role.id}`,
          kind: 'role',
          sourceId: role.id,
          name: role.name,
          op: 'skip',
          reason: roleSkipReason(role),
          spec: null,
          hash: '',
          notes: [
            {
              code: 'managed-role',
              scope: 'role',
              ref: { kind: 'role', id: role.id, name: role.name },
              message: `${role.name}: ${roleSkipReason(role)}, so it is not copied.`,
            },
          ],
        });
        continue;
      }
      const { spec, notes } = buildRoleSpec(role);
      const hash = specHash(spec);
      push({
        key: `role:${role.id}`,
        kind: 'role',
        sourceId: role.id,
        name: role.name,
        op: decide(mappings, 'role', role.id, hash),
        spec,
        hash,
        notes,
      });
    }
    const roleOrder = [...copiedRoles].sort((a, b) => {
      const ra = source.roles.find((r) => r.id === a);
      const rb = source.roles.find((r) => r.id === b);
      return byPosition(ra, rb);
    });
    if (roleOrder.length > 0) {
      const hash = specHash(roleOrder);
      push({
        key: 'order-roles:roles',
        kind: 'order-roles',
        sourceId: 'roles',
        name: 'Role order',
        op: decide(mappings, 'order', 'roles', hash),
        spec: { order: roleOrder },
        hash,
      });
    }
  }

  // 3. categories first, then the other channels, then their order
  if (options.channels) {
    const categories = source.channels.filter((c) => c.type === DISCORD_CHANNEL.CATEGORY).sort(byPosition);
    const others = source.channels.filter((c) => c.type !== DISCORD_CHANNEL.CATEGORY).sort(byPosition);
    for (const ch of [...categories, ...others]) {
      const { spec, notes } = buildChannelSpec(ch, { source, copiedRoles });
      if (!spec) {
        push({
          key: `channel:${ch.id}`,
          kind: 'channel',
          sourceId: ch.id,
          name: ch.name,
          op: 'skip',
          reason: 'no such channel type on Fluxer',
          spec: null,
          hash: '',
          notes,
        });
        continue;
      }
      const hash = specHash(spec);
      push({
        key: `channel:${ch.id}`,
        kind: 'channel',
        sourceId: ch.id,
        name: ch.name,
        op: decide(mappings, 'channel', ch.id, hash),
        spec,
        hash,
        notes,
      });
    }
    const layout = channelOrder(source, copiedChannels);
    if (layout.length > 1) {
      const hash = specHash(layout);
      push({
        key: 'order-channels:channels',
        kind: 'order-channels',
        sourceId: 'channels',
        name: 'Channel order',
        op: decide(mappings, 'order', 'channels', hash),
        spec: { order: layout },
        hash,
      });
    }
  }

  // 4. emoji and stickers, as many as fit
  if (options.emoji) {
    const emojis = source.emojis.filter((e) => !e.managed).sort((a, b) => (a.id < b.id ? -1 : 1));
    addExpressions(steps, {
      kind: 'emoji',
      items: emojis,
      build: buildEmojiSpec,
      mappings,
      slots: slotsLeft(limits.emoji, target?.emojiCount ?? 0, mappings.emoji),
      limitCode: 'emoji-limit',
      noun: 'emoji',
    });
  }
  if (options.stickers) {
    const stickers = [...source.stickers].sort((a, b) => (a.id < b.id ? -1 : 1));
    addExpressions(steps, {
      kind: 'sticker',
      items: stickers,
      build: buildStickerSpec,
      mappings,
      slots: slotsLeft(limits.stickers, target?.stickerCount ?? 0, mappings.sticker),
      limitCode: 'sticker-limit',
      noun: 'sticker',
    });
  }

  // 5. Sylo's own settings
  if (options.modules && modules) {
    for (const mod of modules.source) {
      if (mod.ownerOnly || NOT_COPIED_MODULES.includes(mod.id)) continue;
      // Only a module somebody set up: switched on or off against its default, or with settings saved.
      const hasSettings =
        mod.enabled !== Boolean(mod.defaultEnabled) || Object.keys(mod.config ?? {}).length > 0;
      if (!hasSettings) continue;
      if (modules.targetConfigured.has(mod.id)) {
        push({
          key: `module:${mod.id}`,
          kind: 'module',
          sourceId: mod.id,
          name: mod.name,
          op: 'skip',
          reason: 'already set up on the Fluxer server',
          spec: null,
          hash: '',
          notes: [],
        });
        continue;
      }
      const { spec, notes, remapped } = buildModuleSpec(
        mod,
        { copiedRoles, skippedRoles, copiedChannels, skippedChannels },
        source
      );
      const hash = specHash(spec);
      push({
        key: `module:${mod.id}`,
        kind: 'module',
        sourceId: mod.id,
        name: mod.name,
        op: decide(mappings, 'module', mod.id, hash),
        spec,
        hash,
        notes,
        remapped,
      });
    }
  }

  // 6. the last step: link every copied channel through the bridge (src/mirror/bridgeLink.js)
  push({
    key: 'bridge:link',
    kind: 'bridge',
    sourceId: 'link',
    name: 'Link every copied channel through the bridge',
    op: 'create',
    spec: null,
    hash: '',
  });

  const notes = steps.flatMap((s) => s.notes ?? []);
  return { steps, notes, summary: summarise(steps) };
}

/** Discord's voice-like channels (a stage becomes a voice channel on Fluxer). */
const VOICE_LIKE = new Set([DISCORD_CHANNEL.VOICE, DISCORD_CHANNEL.STAGE]);

/**
 * The copied channels in the order Discord shows them, as the list of moves sent to Fluxer.
 *
 * Discord numbers text-like and voice channels separately (a voice channel at position 0 and a text channel at
 * position 0 can share a category), and shows the text-like ones first; so a channel's place is its kind first and
 * its position second, never the position alone. At the top, the channels without a category come before the
 * categories, as on Discord.
 *
 * The list is in the order the moves are sent: first everything at the top (categories carry their channels along),
 * then the text-like channels of every category, then the voice channels. Fluxer applies the moves one at a time and
 * refuses any move that leaves a voice channel above a text channel in a category; in this order every text-like
 * channel is in place before a voice channel moves, so no step does.
 *
 * Each item: `position` is its index among its siblings (0 first); `voice` marks a voice channel in a category.
 * @returns {Array<{ id: string, parentId: string | null, position: number, voice?: boolean }>}
 */
export function channelOrder(source, copied) {
  const list = source.channels.filter((c) => copied.has(c.id));
  const isCategory = (c) => c.type === DISCORD_CHANNEL.CATEGORY;
  const categories = new Set(list.filter(isCategory).map((c) => c.id));
  const rank = (c) => (VOICE_LIKE.has(c.type) ? 1 : 0);
  const byLayout = (a, b) => rank(a) - rank(b) || byPosition(a, b);
  const roots = [];
  const children = new Map();
  for (const c of list) {
    if (!isCategory(c) && c.parentId && categories.has(c.parentId)) {
      if (!children.has(c.parentId)) children.set(c.parentId, []);
      children.get(c.parentId).push(c);
    } else {
      roots.push(c);
    }
  }
  const top = [
    ...roots.filter((c) => !isCategory(c)).sort(byLayout),
    ...roots.filter(isCategory).sort(byPosition),
  ];
  const out = top.map((c, i) => ({ id: c.id, parentId: null, position: i }));
  const groups = top
    .filter(isCategory)
    .map((cat) =>
      (children.get(cat.id) ?? [])
        .sort(byLayout)
        .map((c, i) => ({ id: c.id, parentId: cat.id, position: i, voice: rank(c) === 1 }))
    );
  for (const group of groups) out.push(...group.filter((c) => !c.voice));
  for (const group of groups) out.push(...group.filter((c) => c.voice));
  return out;
}

/** Fluxer's voice channel type, and its category type: everything else sorts with the text channels. */
const FLUXER_VOICE = 2;
const FLUXER_CATEGORY = 4;

/**
 * The moves for PATCH /guilds/{id}/channels, from channelOrder(): the Discord ids turned into Fluxer ids, and every
 * position counted among the channels that are really there. A channel that has no copy on Fluxer (it could not be
 * made) is left out and counts for nobody's position, and so is a channel whose category has no copy; otherwise a
 * text channel could be placed after a voice channel, which Fluxer refuses.
 *
 * Channels on Fluxer that are not the mirror's stay where they are; a voice channel of the mirror's goes after every
 * text-like channel of its category, the server's own ones included, so it never lands above one of them.
 * @param {ReturnType<typeof channelOrder>} layout
 * @param {Map<string, string>} targetIdOf  Discord channel id -> Fluxer channel id
 * @param {Array<{ id: string, type: number, parentId: string | null }>} fluxerChannels  what is on Fluxer now
 * @returns {Array<{ id: string, position: number, parentId: string | null }>}
 */
export function channelPositionUpdates(layout, targetIdOf, fluxerChannels = []) {
  const ours = new Set(targetIdOf.values());
  const foreignText = new Map();
  for (const c of fluxerChannels) {
    if (ours.has(c.id) || !c.parentId || c.type === FLUXER_VOICE || c.type === FLUXER_CATEGORY) continue;
    foreignText.set(c.parentId, (foreignText.get(c.parentId) ?? 0) + 1);
  }
  const placed = new Map(); // `${parent}|text` and `${parent}|voice` -> how many are placed
  const count = (key) => placed.get(key) ?? 0;
  const updates = [];
  for (const item of layout) {
    const id = targetIdOf.get(item.id);
    if (!id) continue;
    const parentId = item.parentId ? (targetIdOf.get(item.parentId) ?? null) : null;
    if (item.parentId && !parentId) continue;
    const group = parentId ?? '';
    let position;
    if (item.voice) {
      position =
        count(`${group}|text`) + (foreignText.get(parentId) ?? 0) + count(`${group}|voice`);
      placed.set(`${group}|voice`, count(`${group}|voice`) + 1);
    } else {
      position = count(`${group}|text`);
      placed.set(`${group}|text`, position + 1);
    }
    updates.push({ id, position, parentId });
  }
  return updates;
}

function slotsLeft(cap, targetCount, mapped) {
  const ours = mapped?.size ?? 0;
  const foreign = Math.max(0, targetCount - ours);
  return Math.max(0, cap - foreign);
}

function addExpressions(steps, { kind, items, build, mappings, slots, limitCode, noun }) {
  let used = 0;
  // Items that already exist on Fluxer keep their slot; new ones take what is left.
  const ordered = [
    ...items.filter((i) => mappings[kind]?.has(i.id)),
    ...items.filter((i) => !mappings[kind]?.has(i.id)),
  ];
  for (const item of ordered) {
    const { spec, notes } = build(item);
    const base = { key: `${kind}:${item.id}`, kind, sourceId: item.id, name: item.name };
    if (!spec) {
      steps.push({
        ...base,
        op: 'skip',
        reason: notes[0]?.message ?? 'not supported',
        spec: null,
        hash: '',
        notes,
      });
      continue;
    }
    if (used >= slots) {
      steps.push({
        ...base,
        op: 'skip',
        reason: `over Sylo's limit of ${noun}s for a Fluxer server`,
        spec: null,
        hash: '',
        notes: [
          {
            code: limitCode,
            scope: kind,
            ref: { kind, id: item.id, name: item.name },
            message: `${item.name}: there is no room for it on the Fluxer server, so it is not copied.`,
          },
        ],
      });
      continue;
    }
    used += 1;
    const hash = specHash(spec);
    steps.push({ ...base, op: decide(mappings, kind, item.id, hash), spec, hash, notes });
  }
}

/** Counts per kind and operation: { role: { create: 3, update: 0, unchanged: 1, skip: 2 }, ... }. */
export function summarise(steps) {
  const out = {};
  for (const s of steps) {
    out[s.kind] ??= { create: 0, update: 0, unchanged: 0, skip: 0 };
    out[s.kind][s.op] += 1;
  }
  return out;
}
