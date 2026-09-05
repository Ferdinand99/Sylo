// Channel cleanup: per-channel weekly schedule that deletes messages older
// than a configured age. Not event-driven — a polling loop (started on
// import) checks which schedules are due.
import { PermissionFlagsBits } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled } from '../db/modules.js';
import { dueCandidates, markCleanupRan, deleteCleanupSchedule } from '../db/channelCleanup.js';
import { log } from '../lib/log.js';

const MODULE_ID = 'channel-cleanup';
const TICK_MS = 5 * 60_000;
const TICK_MINUTES = TICK_MS / 60_000;
const DUE_WINDOW_MINUTES = TICK_MINUTES * 2; // margin so an occasional slow tick can't skip a run

const FETCH_BATCH = 100;
const MAX_FETCH_BATCHES = 10; // scans at most 1,000 messages in one run
const MAX_INDIVIDUAL_DELETES = 50; // messages over 14 days old are deleted one at a time
const INDIVIDUAL_DELETE_DELAY_MS = 750;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function todayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Is `now` within the schedule's day-of-week + time-of-day trigger window? */
export function isDue(schedule, now = new Date()) {
  if (!schedule.dayList.includes(now.getDay())) return false;
  const [h, m] = String(schedule.time_hhmm)
    .split(':')
    .map((n) => Number(n));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const scheduledMinute = h * 60 + m;
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  return currentMinute >= scheduledMinute && currentMinute < scheduledMinute + DUE_WINDOW_MINUTES;
}

/**
 * Delete messages older than `maxAgeHours` from `channel`, oldest-history-aware
 * (paginates back through the channel rather than assuming recent history).
 * Bulk-deletes what Discord allows (under 14 days) and individually deletes a
 * capped number of older messages so one run can't turn into a long
 * rate-limited loop against a large backlog — the rest catches up next run.
 * @returns {Promise<{ bulkDeleted: number, individualDeleted: number, scanned: number }>}
 */
export async function cleanupChannel(channel, { maxAgeHours, skipPinned }) {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let before;
  let bulkDeleted = 0;
  let individualDeleted = 0;
  let scanned = 0;
  let individualBudget = MAX_INDIVIDUAL_DELETES;

  for (let batchIndex = 0; batchIndex < MAX_FETCH_BATCHES; batchIndex += 1) {
    const page = await channel.messages.fetch({ limit: FETCH_BATCH, ...(before ? { before } : {}) });
    if (!page.size) break;
    scanned += page.size;
    before = page.last().id;

    const candidates = page.filter((m) => m.createdTimestamp < cutoff && !(skipPinned && m.pinned));
    if (candidates.size) {
      const deleted = await channel.bulkDelete(candidates, true).catch(() => new Map());
      bulkDeleted += deleted.size;

      if (individualBudget > 0) {
        for (const msg of candidates.values()) {
          if (deleted.has(msg.id)) continue; // already handled by the bulk call
          if (individualBudget <= 0) break;
          individualBudget -= 1;
          try {
            await msg.delete();
            individualDeleted += 1;
            await sleep(INDIVIDUAL_DELETE_DELAY_MS);
          } catch {
            // already gone, or a permission/rate-limit hiccup — move on
          }
        }
      }
    }

    if (page.size < FETCH_BATCH) break; // reached the start of the channel's history
  }

  return { bulkDeleted, individualDeleted, scanned };
}

async function runSchedule(schedule, today) {
  const guild = runtime.client.guilds.cache.get(schedule.guild_id);
  if (!guild) {
    deleteCleanupSchedule(schedule.guild_id, schedule.id);
    return;
  }
  if (!isModuleEnabled(schedule.guild_id, MODULE_ID)) return;

  const channel = guild.channels.cache.get(schedule.channel_id);
  if (!channel?.isTextBased()) {
    markCleanupRan(schedule.id, today, 0);
    return;
  }
  const me = guild.members.me;
  if (
    !channel
      .permissionsFor(me)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ])
  ) {
    log.error(
      'module:channel-cleanup',
      `missing permissions in #${channel.name} (${guild.name}) — need View Channel, Manage Messages, Read Message History`
    );
    markCleanupRan(schedule.id, today, 0);
    return;
  }

  try {
    const { bulkDeleted, individualDeleted } = await cleanupChannel(channel, {
      maxAgeHours: schedule.max_age_hours,
      skipPinned: schedule.skip_pinned === 1,
    });
    const total = bulkDeleted + individualDeleted;
    markCleanupRan(schedule.id, today, total);
    if (total)
      log.info('module:channel-cleanup', `cleaned ${total} message(s) from #${channel.name} (${guild.name})`);
  } catch (err) {
    log.error('module:channel-cleanup', `cleanup failed for #${channel.name} (${guild.name}):`, err.message);
    markCleanupRan(schedule.id, today, 0);
  }
}

async function tick() {
  if (!runtime.client?.isReady()) return;
  const now = new Date();
  const today = todayStr(now);

  for (const schedule of dueCandidates(today)) {
    if (!isDue(schedule, now)) continue;
    await runSchedule(schedule, today);
  }
}

const timer = setInterval(() => {
  tick().catch((err) => log.error('module:channel-cleanup', 'tick failed:', err.message));
}, TICK_MS);
timer.unref();
