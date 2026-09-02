// /timeout <user> <duration> [reason] — temporarily mute a member (Discord timeout).
import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js';
import { checkActable, notifyTarget, resultEmbed, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { parseDuration, formatDuration } from '../lib/duration.js';

const MAX_MS = 28 * 86_400_000; // Discord's hard limit.

export const data = new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Time a member out for a while (e.g. 10m, 2h, 1d). Max 28d.')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
  .addStringOption((o) => o.setName('duration').setDescription('e.g. 30s, 10m, 2h, 1d, 1w').setRequired(true))
  .addStringOption((o) =>
    o.setName('reason').setDescription('Reason (shown in the audit log)').setMaxLength(400)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const target = interaction.options.getMember('user');
  const reason = interaction.options.getString('reason') ?? NO_REASON;
  const ms = parseDuration(interaction.options.getString('duration', true));

  if (!target) {
    await interaction.reply({ content: "That user isn't in this server.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (ms == null || ms < 1000) {
    await interaction.reply({
      content: '⚠️ Invalid duration. Try `10m`, `2h`, `1d`, `1w`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (ms > MAX_MS) {
    await interaction.reply({
      content: '⚠️ Timeouts can be at most 28 days.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const blocked = checkActable({ interaction, target, action: 'time out' });
  if (blocked) {
    await interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!target.moderatable) {
    await interaction.reply({
      content: "⚠️ I can't time out that member (missing permission or role hierarchy).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const pretty = formatDuration(ms);
  const dmed = await notifyTarget(target.user, {
    guildName: interaction.guild.name,
    action: 'timed out',
    reason,
    extra: `Duration: ${pretty}`,
  });
  await target.timeout(ms, `${interaction.user.tag}: ${reason}`);

  const embed = resultEmbed({
    action: 'Member timed out',
    target: target.user,
    moderator: interaction.user,
    reason,
    fields: [
      { name: 'Duration', value: pretty },
      { name: 'Expires', value: `<t:${Math.floor((Date.now() + ms) / 1000)}:R>` },
      { name: 'Notified', value: dmed ? 'Yes (DM sent)' : 'No (DMs closed)' },
    ],
  });
  await interaction.editReply({ embeds: [embed] });
  await postModLog(interaction.guild, embed);
}
