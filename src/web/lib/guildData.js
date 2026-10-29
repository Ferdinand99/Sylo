// Server-data tools for the dashboard (routes/v2GuildData.js): the config export, the
// member-data lookup and the "forget a member" erasure with its confirmation DM.
import { EmbedBuilder } from 'discord.js';
import { clientOfGuild } from '../../platform/platformOf.js';
import { getModule } from '../../modules/registry.js';
import { exportGuildConfig } from '../../db/exportConfig.js';
import { forgetUser } from '../../db/purge.js';
import { recordAudit } from '../../db/audit.js';

/** What a member-data deletion leaves alone; shown in the DM and on the dashboard pages. */
export const MEMBER_DATA_UNAFFECTED =
  'Messages already posted to channels, a completed giveaway’s winner list, and the server’s config-change log are not affected. ' +
  'Moderation cases and other safety records (a temporary ban, honeypot catches, a counting penalty) are kept.';

/** Fetch a Discord user's tag + avatar for display; falls back to the raw id. */
export async function lookupProfile(guild, userId) {
  try {
    const u = await clientOfGuild(guild).users.fetch(userId);
    return { id: u.id, tag: u.tag, avatar: u.displayAvatarURL({ size: 64, extension: 'png' }) };
  } catch {
    return { id: userId, tag: null, avatar: null };
  }
}

/**
 * The server's config export. An owner-only module's config (registry `ownerOnly`, e.g. App
 * Store Connect) is left out unless the viewer is a Sylo operator: its settings page refuses
 * other admins (middleware/ownerOnlyModules.js), so its export must too.
 * @param {string} guildId
 * @param {{ owner: boolean }} viewer
 */
export async function exportGuildConfigFor(guildId, { owner }) {
  const data = await exportGuildConfig(guildId);
  if (owner) return data;
  return { ...data, modules: data.modules.filter((m) => !getModule(m.moduleId)?.ownerOnly) };
}

/**
 * Erase a member's data in this server (db/purge.js forgetUser — safety records are kept),
 * DM them what was removed, and record it in the audit log.
 * @param {object} guild  the platform guild
 * @param {string} userId
 * @param {{ reason?: string, actor: string }} opts
 * @returns {Promise<{ result: Awaited<ReturnType<typeof forgetUser>>, dmDelivered: boolean }>}
 */
export async function forgetMember(guild, userId, { reason = '', actor }) {
  const r = await forgetUser(guild.id, userId);

  const dm = new EmbedBuilder()
    .setColor(0x58d68d)
    .setTitle(`Your data in ${guild.name} was deleted`)
    .setDescription(
      'A server administrator deleted the data Sylo had stored about you in this server, at your request.'
    )
    .addFields(
      { name: 'Leveling record', value: String(r.leveling), inline: true },
      { name: 'Tickets', value: `${r.tickets} (${r.ticketMessages} msgs)`, inline: true },
      { name: 'Ban appeals', value: String(r.appeals), inline: true },
      { name: 'AFK status', value: String(r.afk), inline: true },
      { name: 'Saved birthday', value: String(r.birthdays), inline: true },
      { name: 'Giveaway entries', value: String(r.giveawayEntries), inline: true },
      { name: 'Event sign-ups', value: String(r.eventSignups), inline: true },
      { name: 'Events hosted (host name removed)', value: String(r.eventsHosted), inline: true },
      { name: 'Suggestion votes', value: String(r.suggestionVotes), inline: true },
      { name: 'Suggestions (made anonymous)', value: String(r.suggestions), inline: true },
      { name: 'Temporary role records', value: String(r.tempRoles), inline: true },
      { name: 'Quotes of their messages', value: String(r.quotes), inline: true },
      { name: 'Saved-by name removed from quotes', value: String(r.quotesSaved), inline: true },
      { name: 'Invite records', value: String(r.invites), inline: true },
      { name: 'Not affected', value: MEMBER_DATA_UNAFFECTED }
    )
    .setTimestamp(Date.now());
  if (reason) dm.addFields({ name: 'Note from staff', value: reason });

  const dmDelivered = await clientOfGuild(guild)
    .users.fetch(userId)
    .then((u) => u.send({ embeds: [dm] }))
    .then(() => true)
    .catch(() => false);

  await recordAudit(guild.id, {
    actor,
    action: 'privacy:member-data',
    detail: `deleted data for ${userId}${reason ? ` — ${reason}` : ''}${dmDelivered ? '' : ' (DM failed)'}`,
  });

  return { result: r, dmDelivered };
}
