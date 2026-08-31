// Reminders: post a stored message (text or embed) to a channel — once at a set
// time, or on a repeating interval with an optional start/end window and a
// weekday filter. Not event-driven: a polling loop (started on import) checks
// for due reminders.
import { runtime } from '../runtime.js';
import { isModuleEnabled } from '../db/modules.js';
import {
  dueScheduled,
  advanceReminder,
  markSingleFired,
  setScheduledEnabled,
  deleteScheduled,
} from '../db/scheduledMessages.js';
import { buildPayload } from './messageCreator.js';
import { sendToChannel } from './lib/send.js';

export const SCHEDULE_PRESETS = [
  ['1', 'Every minute'],
  ['5', 'Every 5 minutes'],
  ['10', 'Every 10 minutes'],
  ['15', 'Every 15 minutes'],
  ['30', 'Every 30 minutes'],
  ['60', 'Every hour'],
  ['120', 'Every 2 hours'],
  ['180', 'Every 3 hours'],
  ['360', 'Every 6 hours'],
  ['720', 'Every 12 hours'],
  ['1440', 'Every day'],
  ['2880', 'Every 2 days'],
  ['10080', 'Every week'],
];

export const WEEKDAYS = [
  [0, 'Sun'],
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
];

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 40320; // 4 weeks
const TICK_MS = 20_000;

const MODULE_ID = 'scheduled-messages';

function payloadFor(reminder) {
  const { payload, empty } = buildPayload(reminder.spec || { content: reminder.content ?? '' });
  if (empty) return null;
  payload.allowedMentions = { parse: ['roles', 'everyone'] };
  return payload;
}

async function tick() {
  if (!runtime.client?.isReady()) return;
  const now = Date.now();

  for (const r of dueScheduled(now)) {
    const enabled = isModuleEnabled(r.guild_id, MODULE_ID);
    const inGuild = runtime.client.guilds.cache.has(r.guild_id);

    if (r.mode === 'single') {
      markSingleFired(r.id, now); // claim it first so a crash can't double-fire
      if (enabled && inGuild) {
        const payload = payloadFor(r);
        if (payload) await sendToChannel(r.guild_id, r.channel_id, payload);
      }
      continue;
    }

    // recurring
    advanceReminder(r.id, r.interval_minutes, now); // claim + schedule next occurrence

    if (!inGuild) {
      deleteScheduled(r.guild_id, r.id);
      continue;
    }
    if (!enabled) continue;
    if (r.end_at && now > r.end_at) {
      setScheduledEnabled(r.guild_id, r.id, false);
      continue;
    }
    if (r.start_at && now < r.start_at) continue;
    if (!r.dayList.includes(new Date(now).getDay())) continue; // not a chosen weekday

    const payload = payloadFor(r);
    if (payload) await sendToChannel(r.guild_id, r.channel_id, payload);
  }
}

const timer = setInterval(() => {
  tick().catch((err) => console.error('[module:reminders] tick failed:', err.message));
}, TICK_MS);
timer.unref();
