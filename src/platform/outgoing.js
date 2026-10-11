// The send half of the component bridge. A command or module builds a normal
// discord.js payload (embeds, buttons, menus); for a platform without native
// components this turns it into something sendable and, once sent, puts the
// reactions on the message and records what each one does.
//
//   const out = prepareOutgoing(payload);          // before sending
//   const sent = await channel.send(out.payload);
//   await attachActions(sent, out, { guildId });   // after sending
//
// Flows that wait for a click with message.createMessageComponentCollector()
// (the /help menu) get a reaction-driven collector on the sent message.
import { EventEmitter } from 'node:events';
import { log } from '../lib/log.js';
import { toFluxerPayload } from './payload.js';
import { planComponents, withComponentText } from './components.js';
import { supports } from './capabilities.js';

/**
 * @param {string | object} input  a discord.js-style message payload
 * @param {{ edit?: boolean, platform?: 'discord'|'fluxer' }} [opts]
 */
export function prepareOutgoing(input, { edit = false, platform = 'fluxer' } = {}) {
  const base = toFluxerPayload(input);
  const components = typeof input === 'object' ? input.components : undefined;
  if (supports(platform, 'components')) {
    // Native components: send them as built, nothing to bridge.
    const json = (c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c);
    const payload =
      components === undefined ? base.payload : { ...base.payload, components: components.map(json) };
    return { ...base, payload, actions: [], touchesComponents: false };
  }
  const plan = planComponents(components);
  let payload = withComponentText(base.payload, plan);
  // An edit that replaces the components must also replace the old legend.
  if (edit && components !== undefined && input.content === undefined)
    payload = { ...payload, content: plan.text };
  return { ...base, payload, actions: plan.actions, touchesComponents: components !== undefined };
}

// --- collectors --------------------------------------------------------------

/** @type {Map<string, Set<ComponentCollector>>} */
const collectors = new Map();

class ComponentCollector extends EventEmitter {
  constructor(messageId, { filter, time, max } = {}) {
    super();
    this.messageId = messageId;
    this.filter = filter;
    this.max = max;
    this.collected = 0;
    this.ended = false;
    if (!collectors.has(messageId)) collectors.set(messageId, new Set());
    collectors.get(messageId).add(this);
    if (time) {
      this._timer = setTimeout(() => this.stop('time'), time);
      this._timer.unref?.();
    }
  }

  stop(reason = 'user') {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this._timer);
    const set = collectors.get(this.messageId);
    set?.delete(this);
    if (set && !set.size) collectors.delete(this.messageId);
    this.emit('end', [], reason);
  }
}

/**
 * Offer an interaction to the collectors waiting on a message.
 * @returns {Promise<boolean>} true when at least one collector owns the message
 */
export async function dispatchToCollectors(messageId, interaction) {
  const set = collectors.get(messageId);
  if (!set?.size) return false;
  for (const c of [...set]) {
    if (c.filter && !(await c.filter(interaction))) continue;
    c.collected += 1;
    c.emit('collect', interaction);
    if (c.max && c.collected >= c.max) c.stop('limit');
  }
  return true;
}

// --- reactions ---------------------------------------------------------------

/**
 * React to a sent (or edited) message and store what the reactions do.
 * @param {any} message  the message returned by the send/edit
 * @param {ReturnType<typeof prepareOutgoing>} out
 * @param {{ guildId: string, ttlMs?: number | null, edit?: boolean }} ctx
 *   `guildId` in platform form ('' for a DM); `ttlMs` makes the actions expire
 *   (short-lived menus), omitted keeps them until the message is deleted.
 */
export async function attachActions(message, out, { guildId, ttlMs = null, edit = false }) {
  message.createMessageComponentCollector ??= (opts) => new ComponentCollector(message.id, opts);
  if (!out.touchesComponents) return;
  if (!out.actions.length && !edit) return;

  const { saveComponentActions, deleteComponentActions } = await import('../db/componentReactions.js');
  if (edit) {
    await message.reactions
      ?.removeAll?.()
      .catch((err) => log.warn('components', 'could not clear reactions:', err.message));
    await deleteComponentActions(message.id);
  }
  if (!out.actions.length) return;

  await saveComponentActions({
    guildId,
    channelId: message.channelId ?? message.channel?.id,
    messageId: message.id,
    actions: out.actions,
    expiresAt: ttlMs ? Date.now() + ttlMs : null,
  });
  for (const a of out.actions) {
    try {
      await message.react(a.emoji);
    } catch (err) {
      log.warn('components', `could not react with ${a.emoji}:`, err.message);
    }
  }
}
