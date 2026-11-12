// /eco add|remove|set|reset-user — staff change a member's money. Needs Manage Server. The change
// goes through the money API (so it is in the member's ledger with who did it and why) and is
// posted to the Economy log channel when the server has set one. The code checks the permission
// itself, so it holds on Fluxer too, where the platform has no access control for commands.
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { LIMITS, MAX_BALANCE, formatMoney, refusalText, staffAdjust } from '../../modules/economy.js';
import { economyGate, reply } from '../lib/economyCmd.js';

const user = (s) => s.addUserOption((o) => o.setName('user').setDescription('The member').setRequired(true));
const reason = (s) =>
  s.addStringOption((o) =>
    o.setName('reason').setDescription('Why (kept in the ledger)').setMaxLength(LIMITS.reason.maxLength)
  );
const amount = (s, min, what) =>
  s.addIntegerOption((o) =>
    o.setName('amount').setDescription(what).setRequired(true).setMinValue(min).setMaxValue(MAX_BALANCE)
  );

export const data = new SlashCommandBuilder()
  .setName('eco')
  .setDescription("Add, remove or set a member's money, or reset their account.")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((s) =>
    reason(amount(user(s.setName('add').setDescription('Give a member cash.')), 1, 'How much to add'))
  )
  .addSubcommand((s) =>
    reason(
      amount(
        user(s.setName('remove').setDescription('Take money from a member (cash first, then bank).')),
        1,
        'How much to remove'
      )
    )
  )
  .addSubcommand((s) =>
    reason(
      amount(
        user(s.setName('set').setDescription("Set a member's cash to an exact amount.")),
        0,
        'The new cash balance'
      )
    )
  )
  .addSubcommand((s) =>
    reason(
      user(
        s
          .setName('reset-user')
          .setDescription('Start a member over: starting balance, empty bank, no streak or cooldowns.')
      )
    )
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  const config = await economyGate(interaction);
  if (!config) return undefined;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return reply(interaction, 'You need the Manage Server permission to use this.');
  }
  const action = interaction.options.getSubcommand();
  const target = interaction.options.getUser('user', true);
  if (target.bot) return reply(interaction, 'Bots do not have an account.');

  const out = await staffAdjust({
    guildId: interaction.guildId,
    actorId: interaction.user.id,
    userId: target.id,
    action,
    amount: action === 'reset-user' ? 0 : interaction.options.getInteger('amount', true),
    reason: interaction.options.getString('reason') ?? '',
    config,
    guild: interaction.guild,
  });
  if (!out.ok) return reply(interaction, refusalText(out, config));

  const now = `Cash ${formatMoney(out.account.cash, config)} · bank ${formatMoney(out.account.bank, config)}.`;
  const what = {
    add: `Added ${formatMoney(out.applied, config)}${out.clamped ? ' (cut to stay under the cap)' : ''} to`,
    remove: `Removed ${formatMoney(-out.applied, config)} from`,
    set: 'Set the cash of',
    'reset-user': 'Reset the account of',
  }[action];
  return reply(
    interaction,
    `${what} <@${target.id}>${action === 'set' ? ` to ${formatMoney(out.account.cash, config)}` : ''}. ${now}`
  );
}
