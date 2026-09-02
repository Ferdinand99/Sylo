// /afk — mark yourself away; Sylo replies to anyone who mentions you.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { isModuleEnabled, getGuildModule } from '../../db/modules.js';
import { setAfk } from '../../db/afk.js';

export const data = new SlashCommandBuilder()
  .setName('afk')
  .setDescription('Set yourself as AFK.')
  .addStringOption((o) =>
    o.setName('reason').setDescription('Shown to people who mention you').setMaxLength(200)
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'afk')) {
    return interaction.reply({
      content: 'AFK is not enabled in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const reason = interaction.options.getString('reason')?.trim() || 'AFK';
  const cfg = getGuildModule(interaction.guildId, 'afk').config;
  const member = interaction.member;

  let oldNick = null;
  if (
    cfg.setNickname !== false &&
    member.manageable &&
    interaction.guild.members.me?.permissions.has('ManageNicknames')
  ) {
    oldNick = member.nickname ?? '';
    const base = member.nickname || interaction.user.globalName || interaction.user.username;
    await member.setNickname(`[AFK] ${base}`.slice(0, 32), 'AFK').catch(() => {
      oldNick = null;
    });
  }

  setAfk(interaction.guildId, interaction.user.id, { reason, oldNick });
  return interaction.reply({ content: `You're now AFK: **${reason}**`, flags: MessageFlags.Ephemeral });
}
