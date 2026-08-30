// Scheduled messages: posts a stored message to a channel every N minutes.
// Not event-driven — a polling loop (started on import) checks for due jobs.
import { runtime } from '../runtime.js';
import { isModuleEnabled } from '../db/modules.js';
import { dueScheduled, markScheduledRan, deleteScheduled } from '../db/scheduledMessages.js';
import { sendToChannel } from './lib/send.js';

export const SCHEDULE_PRESETS = [
  ['1', 'Every minute'],
  ['5', 'Every 5 minutes'],
  ['10', 'Every 10 minutes'],
  ['15', 'Every 15 minutes'],
  ['30', 'Every 30 minutes'],
  ['60', 'Every hour'],
  ['180', 'Every 3 hours'],
  ['360', 'Every 6 hours'],
  ['720', 'Every 12 hours'],
  ['1440', 'Every day'],
  ['10080', 'Every week'],
];

/** Multipliers for the "custom interval" unit dropdown. */
export const SCHEDULE_UNITS = [
  ['1', 'minutes'],
  ['60', 'hours'],
  ['1440', 'days'],
];

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 40320; // 4 weeks
const TICK_MS = 20_000;

async function tick() {
  if (!runtime.client?.isReady()) return;
  const now = Date.now();
  for (const job of dueScheduled(now)) {
    // Advance immediately so a slow send / crash can't double-fire the job.
    markScheduledRan(job.id, job.interval_minutes, now);

    if (!isModuleEnabled(job.guild_id, 'scheduled-messages')) continue;
    if (!runtime.client.guilds.cache.has(job.guild_id)) {
      deleteScheduled(job.guild_id, job.id); // bot no longer in that guild
      continue;
    }
    if (!job.content.trim()) continue;

    await sendToChannel(job.guild_id, job.channel_id, {
      content: job.content.slice(0, 2000),
      allowedMentions: { parse: ['roles', 'everyone'] },
    });
  }
}

const timer = setInterval(() => {
  tick().catch((err) => console.error('[module:scheduled-messages] tick failed:', err.message));
}, TICK_MS);
timer.unref();
