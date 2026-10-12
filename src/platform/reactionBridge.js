// The receive half of the component bridge: a reaction on a message whose
// buttons / menu were rendered as reactions (outgoing.js) becomes the component
// interaction its registered handler expects. Wire it to the chat client's
// reaction event:
//
//   client.on('messageReactionAdd', (reaction, user) => handleReactionAdd(reaction, user));
import { routeComponent } from '../bot/lib/components.js';
import { ReactionInteraction } from '../bot/framework/ReactionInteraction.js';
import { getComponentAction } from '../db/componentReactions.js';
import { dispatchToCollectors } from './outgoing.js';
import { log } from '../lib/log.js';

async function memberOf(message, userId) {
  const members = message.guild?.members;
  if (!members) return null;
  return members.cache.get(userId) ?? (await members.fetch(userId).catch(() => null));
}

/**
 * @param {any} reaction
 * @param {any} user  who reacted
 * @param {{ platform?: 'discord'|'fluxer', privateTtlMs?: number }} [opts]
 */
export async function handleReactionAdd(reaction, user, opts = {}) {
  if (user.bot) return;
  const message = reaction.message;
  const emoji = reaction.emoji?.name;
  if (!emoji) return;

  const action = await getComponentAction(message.id, emoji);
  if (!action || (action.expiresAt && action.expiresAt <= Date.now())) return;

  const interaction = new ReactionInteraction({
    message,
    user,
    member: await memberOf(message, user.id),
    action,
    platform: opts.platform,
    privateTtlMs: opts.privateTtlMs,
  });

  try {
    if (!(await dispatchToCollectors(message.id, interaction))) await routeComponent(interaction);
  } catch (err) {
    log.error('components', `reaction on ${message.id} failed:`, err.message ?? err);
  } finally {
    // Take the reaction back so the same choice can be made again.
    reaction.users?.remove?.(user.id)?.catch?.(() => {});
  }
}
