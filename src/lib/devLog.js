// Posts Sylo's own operational errors to a dedicated Discord channel
// (DEV_LOG_CHANNEL_ID) — deliberately separate from any per-guild
// logging/modlog channel a server admin configures. Those record what
// *members* do; this records when Sylo itself is broken, so the operator
// finds out proactively instead of via a bug report (see docs/roadmap.md
// and issue #178 for the incident that motivated this).
//
// Fire-and-forget by design: notifyDevLog() is synchronous and never throws
// or rejects unhandled, matching log.js's "never let logging throw"
// philosophy — a broken dev-log channel must never take anything else down
// with it. It no-ops until DEV_LOG_CHANNEL_ID is set and the client is ready.
import { runtime } from '../runtime.js';
import { config } from '../config.js';

// Suppress an identical scope+message combo for this long, so a repeating
// failure (e.g. a poll loop erroring every tick) posts once, then again
// periodically, instead of flooding the channel.
const THROTTLE_MS = 5 * 60_000;
const MAX_TRACKED = 500; // bound the throttle map for a long-running process

const lastPosted = new Map(); // "scope|message" -> epoch ms

const COLOR = { error: 0xed4245, warn: 0xfaa61a };
const ICON = { error: '🔴', warn: '🟡' };

function throttled(key) {
  const now = Date.now();
  const last = lastPosted.get(key);
  if (last && now - last < THROTTLE_MS) return true;
  lastPosted.set(key, now);
  if (lastPosted.size > MAX_TRACKED) lastPosted.delete(lastPosted.keys().next().value);
  return false;
}

/**
 * Resolve the dev-log channel and confirm Sylo can actually post there, or
 * throw with a reason a human can act on (surfaced by sendDevLogTest();
 * swallowed by the fire-and-forget notifyDevLog() path below).
 */
async function resolveChannel(channelId) {
  if (!runtime.client?.isReady()) throw new Error('Discord client is not connected yet.');
  const channel = await runtime.client.channels.fetch(channelId);
  if (!channel) throw new Error('No channel with that id — check DEV_LOG_CHANNEL_ID.');
  if (!channel.isTextBased()) throw new Error('That channel is not a text channel.');
  if (channel.guild) {
    const me = channel.guild.members.me;
    if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) {
      throw new Error('Sylo is missing View Channel / Send Messages / Embed Links there.');
    }
  }
  return channel;
}

async function post(channelId, level, scope, message) {
  const channel = await resolveChannel(channelId);
  await channel.send({
    embeds: [
      {
        color: COLOR[level] ?? COLOR.error,
        title: `${ICON[level] ?? ICON.error} ${String(scope)}`,
        description: String(message).slice(0, 4000),
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

/**
 * Fire-and-forget: notify the dev-log channel of an error/warn event.
 * No-op if no channel is configured, the client isn't ready yet, or the same
 * scope+message combo already posted within THROTTLE_MS.
 * @param {'error'|'warn'} level
 * @param {string} scope
 * @param {string} message
 * @param {{ channelId?: string }} [opts] Override the configured channel (tests).
 */
export function notifyDevLog(level, scope, message, { channelId = config.devLogChannelId } = {}) {
  try {
    if (!channelId) return;
    if (!runtime.client?.isReady()) return;
    if (throttled(`${scope}|${message}`)) return;
    post(channelId, level, scope, message).catch(() => {});
  } catch {
    // Never let dev-log notification throw or reject unhandled.
  }
}

/**
 * Send a one-off test message to the configured dev-log channel and report
 * whether it worked. Unlike notifyDevLog(), this does NOT swallow failures —
 * it's what backs the "Send test message" button on /health, so a bad
 * DEV_LOG_CHANNEL_ID or missing permission shows up in the dashboard instead
 * of vanishing exactly like a real notification would.
 * @param {{ channelId?: string }} [opts] Override the configured channel (tests).
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function sendDevLogTest({ channelId = config.devLogChannelId } = {}) {
  if (!channelId) {
    return { ok: false, error: 'DEV_LOG_CHANNEL_ID is not set.' };
  }
  try {
    const channel = await resolveChannel(channelId);
    await channel.send({
      embeds: [
        {
          color: 0x5865f2,
          title: '✅ Dev-log test',
          description: "If you can see this, Sylo's dev-log channel is set up correctly.",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Unknown error' };
  }
}

/** Test-only: clear the throttle state between tests. */
export function _resetDevLogThrottle() {
  lastPosted.clear();
}
