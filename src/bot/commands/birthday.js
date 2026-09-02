// /birthday set|remove|list — members save a birthday for the Birthdays module.
import { SlashCommandBuilder, InteractionContextType, MessageFlags, EmbedBuilder } from 'discord.js';
import { isModuleEnabled } from '../../db/modules.js';
import { setBirthday, getBirthday, removeBirthday, guildBirthdays } from '../../db/birthdays.js';
import { isValidBirthday, daysUntilBirthday } from '../../modules/birthdays.js';
import { INFO_COLOR } from '../lib/moderation.js';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const data = new SlashCommandBuilder()
  .setName('birthday')
  .setDescription('Save your birthday so the server can celebrate it.')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('set')
      .setDescription('Set your birthday.')
      .addIntegerOption((o) =>
        o
          .setName('day')
          .setDescription('Day of the month (1–31)')
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(31)
      )
      .addIntegerOption((o) =>
        o
          .setName('month')
          .setDescription('Month')
          .setRequired(true)
          .addChoices(...MONTHS.map((name, i) => ({ name, value: i + 1 })))
      )
      .addIntegerOption((o) =>
        o
          .setName('year')
          .setDescription('Year (optional — enables an age in the greeting)')
          .setMinValue(1900)
          .setMaxValue(new Date().getFullYear())
      )
  )
  .addSubcommand((s) => s.setName('remove').setDescription('Delete your saved birthday.'))
  .addSubcommand((s) =>
    s.setName('list').setDescription('Show the next birthdays coming up in this server.')
  );

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!isModuleEnabled(interaction.guildId, 'birthdays')) {
    return interaction.reply({
      content: 'The Birthdays module is off in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const sub = interaction.options.getSubcommand();
  const { guildId } = interaction;

  if (sub === 'set') {
    const day = interaction.options.getInteger('day', true);
    const month = interaction.options.getInteger('month', true);
    const year = interaction.options.getInteger('year');
    if (!isValidBirthday(month, day, year ?? null)) {
      return interaction.reply({
        content: `⚠️ ${MONTHS[month - 1]} ${day} isn't a real date.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    setBirthday({ guildId, userId: interaction.user.id, month, day, year: year ?? null });
    return interaction.reply({
      content: `🎂 Saved — **${MONTHS[month - 1]} ${day}**${year ? ` ${year}` : ''}. Use \`/birthday remove\` to delete it.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'remove') {
    const removed = removeBirthday(guildId, interaction.user.id);
    return interaction.reply({
      content: removed ? 'Your birthday has been removed.' : "You don't have a birthday saved here.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // list
  const rows = guildBirthdays(guildId)
    .map((r) => ({ ...r, days: daysUntilBirthday(r.month, r.day) }))
    .sort((a, b) => a.days - b.days)
    .slice(0, 15);

  const embed = new EmbedBuilder().setColor(INFO_COLOR).setTitle('Upcoming birthdays');
  if (rows.length === 0) {
    embed.setDescription('Nobody has saved a birthday yet. Use `/birthday set`.');
  } else {
    embed.setDescription(
      rows
        .map((r) => {
          const when = `${MONTHS[r.month - 1]} ${r.day}`;
          const rel = r.days === 0 ? '**today** 🎉' : r.days === 1 ? 'tomorrow' : `in ${r.days} days`;
          return `<@${r.user_id}> — ${when} · ${rel}`;
        })
        .join('\n')
    );
  }
  const mine = getBirthday(guildId, interaction.user.id);
  if (mine) embed.setFooter({ text: `Yours: ${MONTHS[mine.month - 1]} ${mine.day}` });
  return interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
