// Moderation module. Unlike the event-driven modules, its logic is invoked
// directly from the warning flow (slash command + dashboard).
//
// config shape:
//   {
//     dmOnPunish: boolean,
//     warnThresholds: [ { count, action: 'timeout'|'kick'|'ban', durationMinutes? } ]
//   }
import { EmbedBuilder } from 'discord.js';
import { runtime } from '../runtime.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { dueTempBans, clearTempBan } from '../db/tempBans.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget, MOD_COLOR, INFO_COLOR } from '../bot/lib/moderation.js';
import { formatDuration } from '../bot/lib/duration.js';
import { sendPreBanAppealDm } from './appeals.js';
import { log } from '../lib/log.js';

export const THRESHOLD_ACTIONS = ['timeout', 'kick', 'ban'];
const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Normalise a stored threshold list: drop invalid rows, sort by count. */
export function normaliseThresholds(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => Number.isFinite(Number(r.count)) && Number(r.count) >= 1)
    .map((r) => ({
      count: Math.max(1, Math.min(100, Math.floor(Number(r.count)))),
      action: THRESHOLD_ACTIONS.includes(r.action) ? r.action : 'timeout',
      durationMinutes: Math.max(1, Math.floor(Number(r.durationMinutes) || 60)),
    }))
    .sort((a, b) => a.count - b.count);
}

/**
 * After a warning is issued, apply the strictest matching threshold rule.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} targetUser
 * @param {number} warnCount  the user's new total warning count
 * @param {string} moderatorLabel  who issued the warning (for the mod-log)
 */
export async function applyWarnThresholds(guild, targetUser, warnCount, moderatorLabel) {
  if (!isModuleEnabled(guild.id, 'moderation')) return;
  const config = getGuildModule(guild.id, 'moderation').config;
  const rules = normaliseThresholds(config.warnThresholds);

  // Strictest rule whose count the user has reached (exact or exceeded).
  const rule = [...rules].reverse().find((r) => warnCount >= r.count);
  if (!rule) return;

  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  // Immunity roles (shared with Auto-moderation) are never auto-punished.
  const immune = getGuildModule(guild.id, 'automod').config.exemptRoles;
  if (member && Array.isArray(immune) && immune.some((r) => member.roles.cache.has(r))) return;
  const reason = `Auto: reached ${warnCount} warning(s) (rule at ${rule.count})`;
  let done = null;

  try {
    if (rule.action === 'timeout' && member?.moderatable) {
      await member.timeout(Math.min(rule.durationMinutes * 60_000, MAX_TIMEOUT_MS), reason);
      done = `timed out for ${rule.durationMinutes}m`;
    } else if (rule.action === 'kick' && member?.kickable) {
      if (config.dmOnPunish !== false) {
        await notifyTarget(targetUser, { guildName: guild.name, action: 'kicked', reason });
      }
      await member.kick(reason);
      done = 'kicked';
    } else if (rule.action === 'ban' && guild.members.me?.permissions.has('BanMembers')) {
      if (config.dmOnPunish !== false) {
        // DM before the ban; the appeals module adds the appeal link when active.
        const appeal = await sendPreBanAppealDm(guild, targetUser, reason);
        if (appeal === null) {
          await notifyTarget(targetUser, { guildName: guild.name, action: 'banned', reason });
        }
      }
      await guild.bans.create(targetUser.id, { reason });
      done = 'banned';
    }
  } catch (err) {
    log.error('module:moderation', 'auto-action failed:', err.message);
    return;
  }
  if (!done) return;

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Automatic punishment')
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${targetUser.tag} (\`${targetUser.id}\`)` },
      { name: 'Action', value: done },
      { name: 'Trigger', value: `Warning #${warnCount} · issued by ${moderatorLabel}` }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
}

// --- temporary-ban expiry loop ------------------------------------------
// Mirrors the giveaways expiry loop: a slow tick that lifts bans whose
// `unban_at` has passed. /ban duration:… schedules the rows (src/db/tempBans.js).

const TEMP_BAN_TICK_MS = 30_000;

async function settleTempBan(row) {
  clearTempBan(row.guild_id, row.user_id); // clear first so a throw can't loop
  const guild = runtime.client?.guilds.cache.get(row.guild_id);
  if (!guild?.members.me?.permissions.has('BanMembers')) return;

  const existing = await guild.bans.fetch(row.user_id).catch(() => null);
  if (!existing) return; // already unbanned (manually or by Discord)

  await guild.bans.remove(row.user_id, 'Temporary ban expired');
  const embed = new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle('Temporary ban expired')
    .addFields(
      { name: 'User', value: `<@${row.user_id}> (\`${row.user_id}\`)` },
      { name: 'Original reason', value: row.reason },
      { name: 'Ban length', value: formatDuration(row.unban_at - row.created_at) || 'unknown' }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
}

const tempBanTimer = setInterval(() => {
  if (!runtime.client?.isReady()) return;
  for (const row of dueTempBans(Date.now())) {
    settleTempBan(row).catch((err) => log.error('module:moderation', 'temp-unban failed:', err.message));
  }
}, TEMP_BAN_TICK_MS);
tempBanTimer.unref();
