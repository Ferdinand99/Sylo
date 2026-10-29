// Per-server ceilings for things a server admin creates one by one, so a script cannot grow
// the database without end. A create past the ceiling throws a LimitError, which the web
// server answers with a 400 and the message (src/web/server.js).

export const LIMITS = Object.freeze({
  reminders: 50,
  cleanupSchedules: 25,
  githubWatches: 25,
  composedMessages: 200,
  events: 50,
  eventParticipants: 500,
});

export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.status = 400;
  }
}

/** Throw a LimitError when `count` has reached `max`. */
export function checkLimit(count, max, what) {
  if (Number(count) >= max) throw new LimitError(`This server already has the maximum of ${max} ${what}.`);
}
