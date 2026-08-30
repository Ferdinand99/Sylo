// /ban <user> [reason] [delete_messages] — ban a member, or pre-ban a user by ID.
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  InteractionContextType,
  MessageFlags,
} from 'discord.js';
import { checkActable, notifyTarget, resultEmbed, NO_REASON } from '../lib/moderation.js';
import { postModLog } from '../lib/modlog.js';
import { sendPreBanAppealDm } from '../../modules/appeals.js';

const DELETE_CHOICES = [
  { name: "Don't delete any", value: 0 },
  { name: 'Previous hour', value: 3600 },
  { name: 'Previous 6 hours', value: 21_600 },
  { name: 'Previous 24 hours', value: 86_400 },
  { name: 'Previous 3 days', value: 259_200 },
  { name: 'Previous 7 days', value: 604_800 },
];

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a member (or a user ID that is not in the server).')
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((o) => o.setName('user').setDescription('User to ban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason (shown in the audit log)').setMaxLength(400))
  .addIntegerOption((o) =>
    o.setName('delete_messages').setDescription('Delete this user\'s recent messages').addChoices(...DELETE_CHOICES)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const user = interaction.options.getUser('user', true);
  const member = interaction.options.getMember('user'); // null if not in the guild
  const reason = interaction.options.getString('reason') ?? NO_REASON;
  const deleteMessageSeconds = interaction.options.getInteger('delete_messages') ?? 0;
  const { guild } = interaction;

  if (user.id === interaction.user.id) {
    await interaction.reply({ content: "⚠️ You can't ban yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!guild.members.me) {
    await interaction.reply({ content: "⚠️ I'm not a member of this server, so I can't ban anyone here.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (user.id === guild.members.me.id) {
    await interaction.reply({ content: "⚠️ I can't ban myself.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (user.id === guild.ownerId) {
    await interaction.reply({ content: "⚠️ You can't ban the server owner.", flags: MessageFlags.Ephemeral });
    return;
  }

  if (member) {
    const blocked = checkActable({ interaction, target: member, action: 'ban' });
    if (blocked) {
      await interaction.reply({ content: `⚠️ ${blocked}`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!member.bannable) {
      await interaction.reply({ content: "⚠️ I can't ban that member (missing permission or role hierarchy).", flags: MessageFlags.Ephemeral });
      return;
    }
  }

  const existing = await guild.bans.fetch(user.id).catch(() => null);
  if (existing) {
    await interaction.reply({ content: `⚠️ ${user.tag} is already banned.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();
  // DM before banning — a bot can't message a user it no longer shares a guild
  // with. When the appeals module is active it sends the DM (with the appeal
  // link); otherwise fall back to the plain "you were banned" notice.
  let dmed = false;
  if (member) {
    const appeal = await sendPreBanAppealDm(guild, user, reason);
    dmed = appeal === null
      ? await notifyTarget(user, { guildName: guild.name, action: 'banned', reason })
      : appeal;
  }
  await guild.bans.create(user.id, { reason: `${interaction.user.tag}: ${reason}`, deleteMessageSeconds });

  const embed = resultEmbed({
    action: 'Member banned',
    target: user,
    moderator: interaction.user,
    reason,
    fields: [
      { name: 'Message deletion', value: deleteMessageSeconds ? `${deleteMessageSeconds / 3600}h of messages` : 'None' },
      { name: 'Notified', value: dmed ? 'Yes (DM sent)' : member ? 'No (DMs closed)' : 'No (not in server)' },
    ],
  });
  await interaction.editReply({ embeds: [embed] });
  await postModLog(guild, embed);
}
