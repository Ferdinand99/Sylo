// Server insights — counts messages, joins and leaves per day so the dashboard
// can chart activity over time. Off by default: a server opts in, which is also
// what starts the message counting. Only aggregate counters are stored (see
// src/db/insights.js) — never message content or per-user rows.
//
// Counters live in memory and are flushed to guild_daily hourly and whenever the
// UTC day rolls over. A crash loses at most the last hour.
import { on } from './dispatch.js';
import { accrueDaily, pruneInsights, utcDay } from '../db/insights.js';
import { log } from '../lib/log.js';

const FLUSH_MS = 60 * 60_000; // hourly
const RETENTION_DAYS = 180;

/** @type {Map<string, { day: string, messages: number, joins: number, leaves: number, channels: Map<string, number>, actives: Set<string> }>} */
const buf = new Map();

function freshSlot(day) {
  return { day, messages: 0, joins: 0, leaves: 0, channels: new Map(), actives: new Set() };
}

/** The in-memory slot for a guild's current UTC day, flushing a stale one first. */
function slot(guildId) {
  const today = utcDay();
  let s = buf.get(guildId);
  if (!s) {
    s = freshSlot(today);
    buf.set(guildId, s);
  } else if (s.day !== today) {
    flushSlot(guildId, s);
    s = freshSlot(today);
    buf.set(guildId, s);
  }
  return s;
}

function flushSlot(guildId, s) {
  if (!s.messages && !s.joins && !s.leaves && !s.actives.size) return;
  try {
    accrueDaily(guildId, s.day, {
      joins: s.joins,
      leaves: s.leaves,
      messages: s.messages,
      activeCount: s.actives.size,
      channels: Object.fromEntries(s.channels),
    });
  } catch (err) {
    log.error('insights', `flush ${guildId}: ${err.message}`);
    return;
  }
  s.messages = 0;
  s.joins = 0;
  s.leaves = 0;
  s.channels.clear();
  // Keep `actives` for the rest of the day so the stored count (a running MAX)
  // reflects the whole day's distinct senders, not just the last hour's.
}

function flushAll() {
  const today = utcDay();
  for (const [guildId, s] of buf) {
    flushSlot(guildId, s);
    if (s.day !== today) buf.delete(guildId);
  }
  try {
    pruneInsights(RETENTION_DAYS);
  } catch (err) {
    log.error('insights', `prune: ${err.message}`);
  }
}

on('insights', 'messageCreate', (message) => {
  if (!message.guildId || message.author?.bot) return;
  const s = slot(message.guildId);
  s.messages += 1;
  if (message.author?.id) s.actives.add(message.author.id);
  if (message.channelId) {
    s.channels.set(message.channelId, (s.channels.get(message.channelId) ?? 0) + 1);
  }
});

on('insights', 'guildMemberAdd', (member) => {
  if (member.user?.bot) return;
  slot(member.guild.id).joins += 1;
});

on('insights', 'guildMemberRemove', (member) => {
  if (member.user?.bot) return;
  slot(member.guild.id).leaves += 1;
});

// Exposed for tests.
export const _internals = { buf, flushAll, flushSlot, slot };

const timer = setInterval(flushAll, FLUSH_MS);
timer.unref();
