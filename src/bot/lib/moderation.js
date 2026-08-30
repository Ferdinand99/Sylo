// Shared helpers for the moderation commands: hierarchy/permission checks,
// notifying the target by DM, and building consistent result embeds.
import { EmbedBuilder } from 'discord.js';

export const MOD_COLOR = 0xb4472b;
export const INFO_COLOR = 0x4aa3df;

/** Reason shown when a moderator doesn't supply one. */
export const NO_REASON = 'No reason provided';

/**
 * Verify the moderator and the bot can act on `target`. Returns a user-facing
 * error string when the action must be blocked, or `null` when it's allowed.
 *
 * @param {object} args
 * @param {import('discord.js').ChatInputCommandInteraction} args.interaction
 * @param {import('discord.js').GuildMember} args.target
 * @param {string} args.action  e.g. "kick", "ban", "time out"
 * @returns {string | null}
 */
export function checkActable({ interaction, target, action }) {
  const { guild, member: moderator } = interaction;
  const me = guild.members.me;

  // No bot member on this guild (e.g. the app is user-installed but not added
  // to the server) — nothing we can act on.
  if (!me) return `I'm not a member of this server, so I can't ${action} anyone here.`;
  if (!moderator) return `I couldn't read your roles — try again in a moment.`;

  if (target.id === moderator.id) return `You can't ${action} yourself.`;
  if (target.id === me.id) return `I can't ${action} myself.`;
  if (target.id === guild.ownerId) return `You can't ${action} the server owner.`;

  // Moderator must outrank the target (server owner bypasses role checks).
  if (
    moderator.id !== guild.ownerId &&
    moderator.roles.highest.comparePositionTo(target.roles.highest) <= 0
  ) {
    return `You can't ${action} ${target.user.tag} — their highest role is above or equal to yours.`;
  }

  // The bot must outrank the target too.
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return `I can't ${action} ${target.user.tag} — my highest role is below theirs. Move my role higher in Server Settings.`;
  }

  return null;
}

/**
 * Try to DM the target about an action taken against them. Never throws.
 * @param {import('discord.js').User} user
 * @param {object} info
 * @param {string} info.guildName
 * @param {string} info.action        past tense, e.g. "kicked", "banned"
 * @param {string} info.reason
 * @param {string} [info.extra]       extra line (e.g. duration)
 * @returns {Promise<boolean>} whether the DM was delivered
 */
export async function notifyTarget(user, { guildName, action, reason, extra }) {
  const embed = new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle(`You were ${action} in ${guildName}`)
    .addFields({ name: 'Reason', value: reason });
  if (extra) embed.addFields({ name: 'Details', value: extra });
  embed.setTimestamp(Date.now());

  try {
    await user.send({ embeds: [embed] });
    return true;
  } catch {
    return false; // DMs closed / bot blocked.
  }
}

/**
 * Consistent embed describing a completed moderation action, for the channel
 * reply and the mod-log.
 * @param {object} args
 * @param {string} args.action           display title, e.g. "Member kicked"
 * @param {import('discord.js').User} args.target
 * @param {import('discord.js').User} args.moderator
 * @param {string} args.reason
 * @param {Array<{ name: string, value: string }>} [args.fields]
 * @returns {EmbedBuilder}
 */
export function resultEmbed({ action, target, moderator, reason, fields = [] }) {
  return new EmbedBuilder()
    .setColor(MOD_COLOR)
    .setTitle(action)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: 'User', value: `${target.tag} (\`${target.id}\`)` },
      { name: 'Moderator', value: `${moderator.tag}` },
      { name: 'Reason', value: reason },
      ...fields
    )
    .setTimestamp(Date.now());
}
