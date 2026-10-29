// Moderation module. Unlike the event-driven modules, its logic is invoked
// directly from the warning flow (slash command + dashboard).
//
// config shape:
//   {
//     dmOnPunish: boolean,
//     warnThresholds: [ { count, action: 'timeout'|'kick'|'ban', durationMinutes? } ]
//   }
import { allClientsReady, guildByKey, guildKey } from '../platform/platformOf.js';
import { EmbedBuilder, RESTJSONErrorCodes } from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../db/modules.js';
import { dueTempBans, clearTempBan } from '../db/tempBans.js';
import { addCase, deactivateLatest } from '../db/modCases.js';
import { postModLog } from '../bot/lib/modlog.js';
import { notifyTarget, MOD_COLOR, INFO_COLOR } from '../bot/lib/moderation.js';
import { formatDuration } from '../bot/lib/duration.js';
import { sendPreBanAppealDm } from './appeals.js';
import { log } from '../lib/log.js';
import { every } from './schedule.js';
import { clampRetentionDays } from './lib/retentionDays.js';

/** Setting limits, served to the dashboard (modules/limits.js). */
export const LIMITS = {
  'warnThresholds[].count': { min: 1, max: 100 },
  'warnThresholds[].durationMinutes': { min: 1 },
  infractionRetentionDays: { min: 0, max: 3650 },
};

export const THRESHOLD_ACTIONS = ['timeout', 'kick', 'ban'];
const MAX_TIMEOUT_MS = 28 * 86_400_000;

const COUNT = LIMITS['warnThresholds[].count'];
const DURATION = LIMITS['warnThresholds[].durationMinutes'];

/** Coerce a submitted moderation config into the canonical shape. */
export function normaliseModerationConfig(raw = {}) {
  return {
    dmOnPunish: raw.dmOnPunish !== false,
    warnThresholds: normaliseThresholds(raw.warnThresholds),
    infractionRetentionDays: clampRetentionDays(
      raw.infractionRetentionDays,
      LIMITS.infractionRetentionDays.max
    ),
  };
}

/** Normalise a stored threshold list: drop invalid rows, sort by count. */
export function normaliseThresholds(list) {
  return (Array.isArray(list) ? list : [])
    .filter((r) => Number.isFinite(Number(r.count)) && Number(r.count) >= COUNT.min)
    .map((r) => ({
      count: Math.max(COUNT.min, Math.min(COUNT.max, Math.floor(Number(r.count)))),
      action: THRESHOLD_ACTIONS.includes(r.action) ? r.action : 'timeout',
      durationMinutes: Math.max(DURATION.min, Math.floor(Number(r.durationMinutes) || 60)),
    }))
    .sort((a, b) => a.count - b.count);
}

/** The server's owner, or a member with Administrator or Manage Server. */
const isServerManager = (guild, member) =>
  member.id === guild.ownerId ||
  Boolean(member.permissions?.has('Administrator')) ||
  Boolean(member.permissions?.has('ManageGuild'));

/**
 * After a warning is issued, apply the strictest matching threshold rule.
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} targetUser
 * @param {number} warnCount  the user's new total warning count
 * @param {string} moderatorLabel  who issued the warning (for the mod-log)
 */
export async function applyWarnThresholds(guild, targetUser, warnCount, moderatorLabel) {
  if (!(await isModuleEnabled(guildKey(guild), 'moderation'))) return;
  const config = (await getGuildModule(guildKey(guild), 'moderation')).config;
  const rules = normaliseThresholds(config.warnThresholds);

  // Strictest rule whose count the user has reached (exact or exceeded).
  const rule = [...rules].reverse().find((r) => warnCount >= r.count);
  if (!rule) return;

  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  // Immunity roles (shared with Auto-moderation) are never auto-punished.
  const immune = (await getGuildModule(guildKey(guild), 'automod')).config.exemptRoles;
  if (member && Array.isArray(immune) && immune.some((r) => member.roles.cache.has(r))) return;
  // The punishment runs with the bot's permissions, not the moderator's: never let warnings
  // escalate to the owner or to people who run the server.
  if (member && isServerManager(guild, member)) return;
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
    } else if (
      rule.action === 'ban' &&
      guild.members.me?.permissions.has('BanMembers') &&
      (!member || member.bannable)
    ) {
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

  const caseAction = done.startsWith('timed out') ? 'timeout' : rule.action;
  const { caseNumber } = await addCase({
    guildId: guildKey(guild),
    userId: targetUser.id,
    moderatorId: 'auto',
    action: caseAction,
    reason,
    detail: caseAction === 'timeout' ? `${rule.durationMinutes}m` : null,
  });

  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle('Automatic punishment')
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: 'Case', value: `#${caseNumber}` },
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

// A row is only cleared once the unban is confirmed (or already moot), not
// before — a transient guild.bans.remove() failure (rate limit, momentary API
// error) then just leaves it due for the next tick, instead of forgetting the
// user was ever supposed to be unbanned. A slow settle can still overlap with
// the row being due again on the next tick, hence the in-flight guard below.
const settlingTempBans = new Set();

export async function settleTempBan(row) {
  const guild = guildByKey(row.guild_id);
  if (!guild?.members.me?.permissions.has('BanMembers')) return; // retry next tick

  const existing = await guild.bans.fetch(row.user_id).catch(() => null);
  if (!existing) {
    await clearTempBan(row.guild_id, row.user_id); // already unbanned — nothing left to do
    return;
  }

  try {
    await guild.bans.remove(row.user_id, 'Temporary ban expired');
  } catch (err) {
    // Already gone (race with a manual unban) counts as done; anything else
    // is a real failure, so leave the row in place for the next tick.
    if (err.code !== RESTJSONErrorCodes.UnknownBan) throw err;
  }

  await clearTempBan(row.guild_id, row.user_id);
  const clearedCase = await deactivateLatest(row.guild_id, row.user_id, 'ban');
  const { caseNumber } = await addCase({
    guildId: row.guild_id,
    userId: row.user_id,
    moderatorId: 'auto',
    action: 'unban',
    reason: 'Temporary ban expired',
  });
  const embed = new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle('Temporary ban expired')
    .addFields(
      { name: 'Case', value: clearedCase ? `#${caseNumber} (clears #${clearedCase})` : `#${caseNumber}` },
      { name: 'User', value: `<@${row.user_id}> (\`${row.user_id}\`)` },
      { name: 'Original reason', value: row.reason },
      { name: 'Ban length', value: formatDuration(row.unban_at - row.created_at) || 'unknown' }
    )
    .setTimestamp(Date.now());
  await postModLog(guild, embed);
}

every('moderation', TEMP_BAN_TICK_MS, async () => {
  if (!allClientsReady()) return;
  for (const row of await dueTempBans(Date.now())) {
    const key = `${row.guild_id}:${row.user_id}`;
    if (settlingTempBans.has(key)) continue;
    settlingTempBans.add(key);
    settleTempBan(row)
      .catch((err) => log.error('module:moderation', 'temp-unban failed:', err.message))
      .finally(() => settlingTempBans.delete(key));
  }
});
