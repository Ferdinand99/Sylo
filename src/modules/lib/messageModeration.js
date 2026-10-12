// Lets the prefix-command router wait for moderation before it runs a command.
//
// On Fluxer a chat message reaches two independent listeners: the module events (automod,
// honeypot, ...) and the command router. Without this, a message automod just deleted for
// carrying an invite would still run its command. The module-event listener registers the
// moderation work for a message; modules that act on it mark it; the router awaits the work
// and skips the command when it was marked.
const pending = new WeakMap();
const moderated = new WeakSet();

/** @param {object} message  @param {Promise<unknown>} work  the moderation dispatch for this message */
export function beginModeration(message, work) {
  pending.set(message, work);
}

/** A module acted on this message (deleted it, punished its author, flagged it). */
export function markModerated(message) {
  moderated.add(message);
}

/**
 * Wait for the message's moderation to finish; true when something acted on it. The wait is
 * bounded: the work covers every message handler, and one stuck module must not hold every
 * command back, so after `timeoutMs` the command is judged on what has been marked so far.
 */
export async function moderationOutcome(message, { timeoutMs = 3000 } = {}) {
  const work = pending.get(message);
  if (work) {
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([work.catch(() => {}), limit]);
    clearTimeout(timer);
  }
  return moderated.has(message);
}
