// Server insights — counts messages, joins, leaves and voice-channel usage per
// day (and per hour) so the dashboard can chart activity over time. Off by
// default: a server opts in, which is also what starts the counting. Only
// aggregate counters are stored (see src/db/insights.js) — never message content
// or per-user rows.
//
// Counters live in memory and are flushed to guild_daily + guild_hourly every
// few minutes, on the UTC day roll, and on demand (the "Refresh now" button).
// A crash loses at most the last few minutes; a voice session in progress loses
// only its unflushed tail.
import { on } from './dispatch.js';
import { accrueDaily, accrueHourly, pruneInsights, utcDay, utcHour } from '../db/insights.js';
import { getTempChannel } from '../db/tempVoice.js';
import { log } from '../lib/log.js';

// A "join to create" spawn is deleted within minutes, so its channel id is
// meaningless on the dashboard later. Capture its name now (the row still
// exists) and bucket by `name:<name>` instead — sessions in same-named temp
// channels then roll up together. Real channels keep their id and resolve to a
// live name at render time.
async function voiceBucket(channelId) {
  const temp = await getTempChannel(channelId);
  return temp ? `name:${(temp.name || 'Temporary channel').slice(0, 80)}` : channelId;
}

const FLUSH_MS = 10 * 60_000; // every 10 minutes
const RETENTION_DAYS = 180;
const RETENTION_HOURS = 72;

/**
 * @typedef {Object} Slot
 * @property {string} day
 * @property {number} messages @property {number} joins @property {number} leaves
 * @property {Map<string, number>} channels          messages per channel, this flush
 * @property {Set<string>} dayActives @property {Set<string>} hourActives
 * @property {Map<string, { at: number, channelId: string }>} voiceStart  open sessions
 * @property {number} voiceMinutes                   accrued since last flush (float)
 * @property {Map<string, number>} voiceChannels     minutes per channel, this flush
 * @property {Set<string>} dayVoiceActives @property {Set<string>} hourVoiceActives
 * @property {number} voicePeakDay @property {number} voicePeakFlush
 */

/** @type {Map<string, Slot>} */
const buf = new Map();

// accrueDaily/accrueHourly are real (if normally fast) I/O now, not the
// synchronous SQLite writes they used to be — flushSlot() has an `await`
// between reading a slot's counters and resetting them. Without this guard,
// the periodic flushAll() tick and a "Refresh now" click (flushGuild, from
// the dashboard) could both start flushing the *same* guild's slot before
// either finishes, sending its buffered counters to accrueDaily/accrueHourly
// twice — a real double-count, not just an imprecision. One in-flight flush
// per guild at a time; a second caller for the same guild is a no-op (the
// first one flushes what's there; nothing is lost, just deferred to it).
const flushing = new Set();

function freshSlot(day) {
  return {
    day,
    messages: 0,
    joins: 0,
    leaves: 0,
    channels: new Map(),
    dayActives: new Set(),
    hourActives: new Set(),
    voiceStart: new Map(),
    voiceMinutes: 0,
    voiceChannels: new Map(),
    dayVoiceActives: new Set(),
    hourVoiceActives: new Set(),
    voicePeakDay: 0,
    voicePeakFlush: 0,
  };
}

/** The in-memory slot for a guild's current UTC day, flushing a stale one first. */
async function slot(guildId) {
  const today = utcDay();
  let s = buf.get(guildId);
  if (!s) {
    s = freshSlot(today);
    buf.set(guildId, s);
  } else if (s.day !== today) {
    await flushSlot(guildId, s); // settles open voice sessions up to now
    const carried = s.voiceStart; // keep tracking calls that span midnight
    s = freshSlot(today);
    s.voiceStart = carried;
    buf.set(guildId, s);
  }
  return s;
}

/** Add elapsed time for every open voice session to the flush totals; keep them open. */
async function settleVoice(s, now) {
  for (const sess of s.voiceStart.values()) {
    const mins = (now - sess.at) / 60_000;
    if (mins > 0) {
      s.voiceMinutes += mins;
      const vb = await voiceBucket(sess.channelId);
      s.voiceChannels.set(vb, (s.voiceChannels.get(vb) ?? 0) + mins);
    }
    sess.at = now;
  }
}

async function flushSlot(guildId, s) {
  if (flushing.has(guildId)) return; // already being flushed elsewhere — see `flushing` comment above
  flushing.add(guildId);
  try {
    const now = Date.now();
    await settleVoice(s, now);

    const empty =
      !s.messages &&
      !s.joins &&
      !s.leaves &&
      !s.dayActives.size &&
      s.voiceMinutes < 0.5 &&
      !s.dayVoiceActives.size;
    if (empty) return;

    const voiceMins = Math.round(s.voiceMinutes);
    const voiceChannels = Object.fromEntries(
      [...s.voiceChannels].map(([k, v]) => [k, Math.round(v)]).filter(([, v]) => v > 0)
    );
    const common = {
      joins: s.joins,
      leaves: s.leaves,
      messages: s.messages,
      voiceMinutes: voiceMins,
    };

    try {
      await accrueDaily(guildId, s.day, {
        ...common,
        activeCount: s.dayActives.size,
        voiceActiveCount: s.dayVoiceActives.size,
        voicePeak: s.voicePeakDay,
        channels: Object.fromEntries(s.channels),
        voiceChannels,
      });
      await accrueHourly(guildId, utcHour(now), {
        ...common,
        activeCount: s.hourActives.size,
        voiceActiveCount: s.hourVoiceActives.size,
        voicePeak: s.voicePeakFlush,
      });
    } catch (err) {
      log.error('insights', `flush ${guildId}: ${err.message}`);
      return;
    }

    // Reset per-flush accumulators; keep the day-scoped sets + open sessions.
    // Subtracting (not hard-clearing) the exact amount just flushed means an
    // event that lands in the `await` window above — a message arriving
    // mid-flush, say — isn't wiped by the reset below; it survives into the
    // next flush instead. The Map/Set fields below (channels, hourActives,
    // …) don't get the same treatment: they're cosmetic breakdowns on an
    // already-approximate rollup, and a hard clear here only risks losing an
    // entry from that same narrow window, self-correcting next flush — not
    // worth the complexity of a general Map/Set diff for that.
    s.messages -= common.messages;
    s.joins -= common.joins;
    s.leaves -= common.leaves;
    s.channels.clear();
    s.hourActives.clear();
    s.voiceMinutes -= voiceMins; // carry the sub-minute remainder
    s.voiceChannels.clear();
    s.hourVoiceActives.clear();
    s.voicePeakFlush = 0;
  } finally {
    flushing.delete(guildId);
  }
}

async function flushAll() {
  const today = utcDay();
  for (const [guildId, s] of buf) {
    await flushSlot(guildId, s);
    // Drop a guild only once its day has rolled AND nobody is still in voice.
    if (s.day !== today && s.voiceStart.size === 0) buf.delete(guildId);
  }
  try {
    await pruneInsights(RETENTION_DAYS, RETENTION_HOURS);
  } catch (err) {
    log.error('insights', `prune: ${err.message}`);
  }
}

on('insights', 'messageCreate', async (message) => {
  if (!message.guildId || message.author?.bot) return;
  const s = await slot(message.guildId);
  s.messages += 1;
  if (message.author?.id) {
    s.dayActives.add(message.author.id);
    s.hourActives.add(message.author.id);
  }
  if (message.channelId) {
    s.channels.set(message.channelId, (s.channels.get(message.channelId) ?? 0) + 1);
  }
});

on('insights', 'guildMemberAdd', async (member) => {
  if (member.user?.bot) return;
  (await slot(member.guild.id)).joins += 1;
});

on('insights', 'guildMemberRemove', async (member) => {
  if (member.user?.bot) return;
  (await slot(member.guild.id)).leaves += 1;
});

on('insights', 'voiceStateUpdate', async ({ old: before, new: after }) => {
  const guild = after.guild ?? before.guild;
  const member = after.member ?? before.member;
  if (!guild || !member || member.user?.bot) return;

  const s = await slot(guild.id);
  const now = Date.now();
  const from = before.channelId;
  const to = after.channelId;
  if (from === to) return; // mute / deafen / stream toggle — not a move

  // Close the session we were tracking (leave, or move-out).
  const sess = s.voiceStart.get(member.id);
  if (sess) {
    const mins = (now - sess.at) / 60_000;
    if (mins > 0) {
      s.voiceMinutes += mins;
      const vb = await voiceBucket(sess.channelId);
      s.voiceChannels.set(vb, (s.voiceChannels.get(vb) ?? 0) + mins);
    }
    s.voiceStart.delete(member.id);
  }
  // Open a session (join, or move-in).
  if (to) {
    s.voiceStart.set(member.id, { at: now, channelId: to });
    s.dayVoiceActives.add(member.id);
    s.hourVoiceActives.add(member.id);
  }

  // Peak concurrent — counted from the live cache so a restart doesn't undercount.
  const inVoice = [...guild.voiceStates.cache.values()].filter(
    (vs) => vs.channelId && vs.member?.user?.bot !== true
  ).length;
  if (inVoice > s.voicePeakDay) s.voicePeakDay = inVoice;
  if (inVoice > s.voicePeakFlush) s.voicePeakFlush = inVoice;
});

/** Write a single guild's in-memory counters to the DB now (the dashboard's
 *  "Refresh now" button). No-op when nothing has been buffered yet. */
export async function flushGuild(guildId) {
  const s = buf.get(guildId);
  if (s) await flushSlot(guildId, s);
}

// Exposed for tests.
export const _internals = { buf, flushAll, flushSlot, slot, settleVoice };

const timer = setInterval(
  () => flushAll().catch((e) => log.error('insights', `flushAll: ${e.message}`)),
  FLUSH_MS
);
timer.unref();
// A first flush shortly after boot so the page isn't empty for the first cycle.
setTimeout(() => flushAll().catch(() => {}), 90_000).unref();
