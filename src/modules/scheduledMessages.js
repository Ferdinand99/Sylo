// Reminders: post a stored message (text or embed) to a channel — once at a set
// time, or on a repeating interval with an optional start/end window and a
// weekday filter. Not event-driven: a polling loop (started on import) checks
// for due reminders.
import { allClientsReady, guildByKey } from '../platform/platformOf.js';
import { getGuildModule } from '../db/modules.js';
import {
  dueScheduled,
  advanceReminder,
  markSingleFired,
  setScheduledEnabled,
  deleteScheduled,
} from '../db/scheduledMessages.js';
import { buildPayload } from './messageCreator.js';
import { sendToChannel } from './lib/send.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';
import { normaliseEmbedSpec } from './welcomeChannel.js';

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

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  name: { maxLength: 100 },
  content: { maxLength: 2000 },
  intervalMinutes: { min: 1, max: 40320 }, // up to 4 weeks
};
export const MIN_INTERVAL_MINUTES = LIMITS.intervalMinutes.min;
export const MAX_INTERVAL_MINUTES = LIMITS.intervalMinutes.max;

function toMs(v) {
  const t = new Date(String(v ?? '')).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Coerce a reminder as the dashboard sends it (create, edit and test) into the shape the database
 * stores. Not a settings object: reminders are rows of their own table.
 */
export function normaliseReminderConfig(body = {}) {
  const channelId = /^\d{17,20}$/.test(body.channelId ?? '') ? body.channelId : '';
  let embed = null;
  let content = body.content;
  // Embed mode's "text above the embed" lives on the EmbedEditor's own spec
  // (content:true), not the plain-text textarea used in text mode.
  if (body.msgType === 'embed' && body.embedSpec && typeof body.embedSpec === 'object') {
    embed = normaliseEmbedSpec(body.embedSpec);
    content = body.embedSpec.content;
  }
  const spec = {
    content: String(content ?? '').slice(0, LIMITS.content.maxLength),
    embeds: embed ? [embed] : [],
  };
  const mode = body.mode === 'single' ? 'single' : 'multiple';
  const intervalMinutes = Math.min(
    MAX_INTERVAL_MINUTES,
    Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(body.intervalMinutes)) || 60)
  );
  const days = (Array.isArray(body.days) ? body.days : []).map(Number).filter((n) => n >= 0 && n <= 6);
  return {
    name:
      String(body.name ?? '')
        .trim()
        .slice(0, LIMITS.name.maxLength) || 'Untitled reminder',
    channelId,
    spec,
    mode,
    intervalMinutes,
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    startAt: body.enableStart ? toMs(body.startAt) : null,
    endAt: body.enableEnd ? toMs(body.endAt) : null,
    runAt: mode === 'single' ? toMs(body.runAt) : null,
  };
}
const TICK_MS = 20_000;

const MODULE_ID = 'reminders';

/**
 * Does this server let its reminders ping? Off unless the server owner or someone with Manage
 * Server turned it on (Reminders page): a bot master may use the whole dashboard, but must not
 * be able to make Sylo ping @everyone, @here or any role with Sylo's own rights.
 */
export function remindersMayPing(moduleConfig) {
  return moduleConfig?.allowPings === true;
}

/** The message a reminder posts. Without pings allowed, mentions in the text are shown but silent. */
export function reminderPayload(reminder, allowPings = false) {
  const { payload, empty } = buildPayload(reminder.spec || { content: reminder.content ?? '' });
  if (empty) return null;
  payload.allowedMentions = allowPings ? { parse: ['roles', 'everyone'] } : { parse: [] };
  return payload;
}

async function tick() {
  if (!allClientsReady()) return;
  const now = Date.now();

  for (const r of await dueScheduled(now)) {
    const mod = await getGuildModule(r.guild_id, MODULE_ID);
    const enabled = mod.enabled;
    const allowPings = remindersMayPing(mod.config);
    const inGuild = Boolean(guildByKey(r.guild_id));

    if (r.mode === 'single') {
      await markSingleFired(r.id, now); // claim it first so a crash can't double-fire
      if (enabled && inGuild) {
        const payload = reminderPayload(r, allowPings);
        if (payload) await sendToChannel(r.guild_id, r.channel_id, payload);
      }
      continue;
    }

    // recurring
    await advanceReminder(r.id, r.interval_minutes, now); // claim + schedule next occurrence

    if (!inGuild) {
      await deleteScheduled(r.guild_id, r.id);
      continue;
    }
    if (!enabled) continue;
    if (r.end_at && now > r.end_at) {
      await setScheduledEnabled(r.guild_id, r.id, false);
      continue;
    }
    if (r.start_at && now < r.start_at) continue;
    if (!r.dayList.includes(new Date(now).getDay())) continue; // not a chosen weekday

    const payload = reminderPayload(r, allowPings);
    if (payload) await sendToChannel(r.guild_id, r.channel_id, payload);
  }
}

every('reminders', TICK_MS, () => {
  tick().catch((err) => log.error('module:reminders', 'tick failed:', err.message));
});
