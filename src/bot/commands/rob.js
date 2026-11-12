// /rob <user> — try to steal another member's cash. Off unless the server turns it on. The rules
// (chance, cooldown, who is protected) are in modules/economy.js doRob; the result is posted in the
// channel and a victim of a successful robbery gets a DM.
import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { doRob, formatMoney, refusalText } from '../../modules/economy.js';
import { announce, economyGate, reply } from '../lib/economyCmd.js';

export const data = new SlashCommandBuilder()
  .setName('rob')
  .setDescription('Try to steal cash from another member. Risky: get caught and you pay a fine.')
  .setContexts(InteractionContextType.Guild)
  .addUserOption((o) => o.setName('user').setDescription('Who to rob').setRequired(true));

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  if (!config.robEnabled) return reply(interaction, refusalText({ reason: 'rob_off' }, config));

  const target = interaction.options.getUser('user', true);
  const member =
    interaction.options.getMember?.('user') ??
    (await interaction.guild.members.fetch(target.id).catch(() => null));
  if (!member) return reply(interaction, 'That member is not in this server.');

  const out = await doRob({
    guildId: interaction.guildId,
    robberId: interaction.user.id,
    victimId: target.id,
    victimIsBot: target.bot === true,
    victimJoinedAt: member.joinedTimestamp ?? null,
    config,
  });
  if (!out.ok) return reply(interaction, refusalText(out, config));

  const robber = `<@${interaction.user.id}>`;
  const victim = `<@${target.id}>`;
  if (!out.success) {
    const text =
      out.amount > 0
        ? `${robber} was caught trying to rob ${victim} and paid a fine of ${formatMoney(out.amount, config)}.`
        : `${robber} was caught trying to rob ${victim}, but had nothing to pay.`;
    return announce(interaction, text, [target.id]);
  }

  // The victim hears about it in a DM (closed DMs are fine: the channel post still names them).
  target
    .send({
      content: `You were robbed in **${interaction.guild.name}**: ${interaction.user.username} took ${formatMoney(out.amount, config)} of your cash. Keep your money in the bank with /deposit to be safe.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});
  return announce(
    interaction,
    `${robber} robbed ${victim} and got away with ${formatMoney(out.amount, config)}!`,
    [target.id]
  );
}
