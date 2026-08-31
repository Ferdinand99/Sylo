// /invites [user] — a member's invite tally, plus a personal invite link.
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { getInviteCount, inviterRank, inviterCount, getPersonalCode, setPersonalCode } from '../../db/inviteTracker.js';
import { primeGuild } from '../../modules/inviteTracker.js';

export const data = new SlashCommandBuilder()
  .setName('invites')
  .setDescription('Show your invite count and personal invite link (or another member’s count).')
  .addUserOption((o) => o.setName('user').setDescription('Whose invites to show').setRequired(false));

function pickInviteChannel(guild) {
  const me = guild.members.me;
  const usable = (ch) =>
    ch?.isTextBased() && ch.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite);
  if (usable(guild.systemChannel)) return guild.systemChannel;
  if (usable(guild.rulesChannel)) return guild.rulesChannel;
  return [...guild.channels.cache.values()]
    .filter((ch) => ch.type === 0 && usable(ch))
    .sort((a, b) => a.rawPosition - b.rawPosition)[0] ?? null;
}

// -> { url } on success, or { error } describing what permission is missing.
async function personalLink(guild, userId) {
  let all;
  try {
    all = await guild.invites.fetch();
  } catch {
    return { error: 'I need the **Manage Server** permission to hand out invite links.' };
  }
  const existing = getPersonalCode(guild.id, userId);
  if (existing && all.has(existing)) return { url: `https://discord.gg/${existing}` };

  const channel = pickInviteChannel(guild);
  if (!channel) return { error: 'I need the **Create Invite** permission in at least one channel.' };
  try {
    const invite = await channel.createInvite({
      maxAge: 0,
      unique: true,
      reason: `Personal invite link via /invites for ${userId}`,
    });
    setPersonalCode(guild.id, userId, invite.code);
    await primeGuild(guild); // teach the cache about the new code
    return { url: invite.url };
  } catch {
    return { error: 'I could not create an invite link — check my channel permissions.' };
  }
}

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
  }
  if (!isModuleEnabled(interaction.guildId, 'invite-tracker')) {
    return interaction.reply({ content: 'Invite tracking is not enabled in this server.', flags: MessageFlags.Ephemeral });
  }

  const target = interaction.options.getUser('user') ?? interaction.user;
  const isSelf = target.id === interaction.user.id;
  const c = getInviteCount(interaction.guildId, target.id);

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setAuthor({ name: `${target.tag} — invites`, iconURL: target.displayAvatarURL() })
    .addFields(
      { name: 'Invites', value: `**${c.net}**`, inline: true },
      { name: 'Rank', value: `#${inviterRank(interaction.guildId, target.id)} of ${inviterCount(interaction.guildId)}`, inline: true },
      {
        name: 'Breakdown',
        value:
          `${c.regular} joined · ${c.leaves} left` +
          (c.bonus ? ` · ${c.bonus > 0 ? '+' : ''}${c.bonus} bonus` : ''),
      }
    );

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (isSelf) {
    const link = await personalLink(interaction.guild, target.id);
    if (link.url) embed.addFields({ name: 'Your invite link', value: link.url });
    else embed.addFields({ name: 'Your invite link', value: link.error });
  }

  await interaction.editReply({ embeds: [embed] });
}
