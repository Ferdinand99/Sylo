// Birthdays: members set their birthday with /birthday; a daily tick posts a
// greeting in a configured channel and (optionally) gives them a role for the
// day. Cross-guild, so the tick runs once per day guarded by an app-setting.
//
// config shape: { channel, message, roleId, pingRole }
import { EmbedBuilder } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { getAppSetting, setAppSetting } from '../db/appSettings.js';
import { birthdaysOnDay, guildBirthdays } from '../db/birthdays.js';
import { log } from '../lib/log.js';

const DEFAULT_MESSAGE = '🎂 Happy birthday {user}! 🎉';
const LAST_RUN_KEY = 'birthdays:lastRun';

export function normaliseBirthdaysConfig(raw = {}) {
  return {
    channel: /^\d{17,20}$/.test(raw.channel ?? '') ? raw.channel : '',
    message:
      String(raw.message ?? '')
        .trim()
        .slice(0, 1000) || DEFAULT_MESSAGE,
    roleId: /^\d{17,20}$/.test(raw.roleId ?? '') ? raw.roleId : '',
    pingRole: Boolean(raw.pingRole),
  };
}

/** Whole days from `from` until the next occurrence of month/day (0 = today). */
export function daysUntilBirthday(month, day, from = new Date()) {
  const y = from.getFullYear();
  const today = new Date(y, from.getMonth(), from.getDate());
  let next = new Date(y, month - 1, day);
  if (next < today) next = new Date(y + 1, month - 1, day);
  return Math.round((next - today) / 86_400_000);
}

/** True for a real calendar date (Feb 29 allowed — year optional). */
export function isValidBirthday(month, day, year) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  if (year != null && (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear())) {
    return false;
  }
  // Use a leap year (2000) so Feb 29 validates when no year is given.
  const probe = new Date(year ?? 2000, month - 1, day);
  return probe.getMonth() === month - 1 && probe.getDate() === day;
}

function ageOn(bday, when) {
  if (!bday.year) return null;
  let age = when.getFullYear() - bday.year;
  const had =
    when.getMonth() + 1 > bday.month || (when.getMonth() + 1 === bday.month && when.getDate() >= bday.day);
  if (!had) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

function fillMessage(template, mention, age) {
  return String(template || DEFAULT_MESSAGE)
    .replaceAll('{user}', mention)
    .replaceAll('{age}', age == null ? '' : String(age))
    .trim();
}

/** Rows to celebrate today for `guildId`, incl. the Feb-29 → Feb-28 fallback. */
function celebrantsToday(guildId, now) {
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const rows = birthdaysOnDay(guildId, month, day);
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (month === 2 && day === 28 && !isLeap(now.getFullYear())) {
    rows.push(...birthdaysOnDay(guildId, 2, 29));
  }
  return rows;
}

async function celebrateGuild(guildId, now) {
  const guild = runtime.client?.guilds.cache.get(guildId);
  if (!guild) return;
  const cfg = normaliseBirthdaysConfig(getGuildModule(guildId, 'birthdays').config);
  const rows = celebrantsToday(guildId, now);
  const celebrantIds = new Set(rows.map((r) => r.user_id));

  // Birthday role: strip it from yesterday's holders, grant it to today's.
  if (cfg.roleId) {
    const role = guild.roles.cache.get(cfg.roleId);
    const me = guild.members.me;
    if (role && me?.permissions.has('ManageRoles') && me.roles.highest.comparePositionTo(role) > 0) {
      for (const member of role.members.values()) {
        if (!celebrantIds.has(member.id)) await member.roles.remove(role, 'Birthday over').catch(() => {});
      }
      for (const id of celebrantIds) {
        const m = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
        if (m && !m.roles.cache.has(role.id)) await m.roles.add(role, 'Birthday').catch(() => {});
      }
    }
  }

  if (!cfg.channel || rows.length === 0) return;
  const channel =
    guild.channels.cache.get(cfg.channel) ?? (await guild.channels.fetch(cfg.channel).catch(() => null));
  if (!channel?.isTextBased()) return;

  for (const row of rows) {
    const age = ageOn(row, now);
    const embed = new EmbedBuilder()
      .setColor(0xf0b232)
      .setDescription(fillMessage(cfg.message, `<@${row.user_id}>`, age))
      .setTimestamp(now);
    if (age != null) embed.setFooter({ text: `Turning ${age} today` });
    await channel
      .send({
        content: cfg.pingRole && cfg.roleId ? `<@&${cfg.roleId}>` : undefined,
        embeds: [embed],
        allowedMentions: { users: [row.user_id], roles: cfg.pingRole && cfg.roleId ? [cfg.roleId] : [] },
      })
      .catch(() => {});
  }
}

/** Run the daily sweep if the calendar day has rolled over since last time. */
export async function runBirthdaySweep(now = new Date()) {
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (getAppSetting(LAST_RUN_KEY) === today) return;
  setAppSetting(LAST_RUN_KEY, today);

  for (const guild of runtime.client?.guilds.cache.values() ?? []) {
    if (!isModuleEnabled(guild.id, 'birthdays')) continue;
    try {
      await celebrateGuild(guild.id, now);
    } catch (err) {
      log.error('module:birthdays', `sweep for ${guild.id} failed:`, err.message);
    }
  }
}

export { guildBirthdays };

// Check hourly; the app-setting guard means only the first check after midnight
// does any work, and a mid-day restart doesn't re-post.
const TICK_MS = 60 * 60 * 1000;
const timer = setInterval(() => {
  if (runtime.client?.isReady()) runBirthdaySweep().catch(() => {});
}, TICK_MS);
timer.unref();
setTimeout(() => {
  if (runtime.client?.isReady()) runBirthdaySweep().catch(() => {});
}, 15_000).unref();
