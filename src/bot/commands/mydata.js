// /mydata — self-service export of the data Sylo stores about the caller in the
// current guild (GDPR access + portability). Read only; use /forget to delete.
// The caller gets a readable summary embed plus the full copy as a JSON file,
// by DM — or on the ephemeral reply if their DMs are closed.
import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags, time } from 'discord.js';
import { exportUserData } from '../../db/purge.js';

const COOLDOWN_MS = 10 * 60_000; // one export per member per guild per 10 min
const MAX_BYTES = 7 * 1024 * 1024; // stay well under Discord's upload limit
const MAX_LINES = 15; // summary lines in the embed before deferring to the file

/** `${guildId}:${userId}` -> last successful export time. Cleared on restart. */
const lastRun = new Map();

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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (ms) => time(Math.floor(ms / 1000), 'd');

// Compact, human rendering of a source's rows for the summary embed. Falls back
// to a plain row count. Cosmetic only — the JSON file is the authoritative copy.
const render = {
  warnings: (r) =>
    `${plural(r.length, 'case')} · latest #${r.at(-1).case_number} ${r.at(-1).action} (${day(r.at(-1).created_at)})`,
  leveling: (r) => {
    const l = r[0];
    const bits = [`Level ${l.level}`, `${l.xp} XP`, plural(l.messages, 'message')];
    if (l.voice_minutes) bits.push(`${l.voice_minutes} min voice`);
    return bits.join(' · ');
  },
  levelingPeriods: (r) => `${plural(r.length, 'weekly / monthly entry', 'weekly / monthly entries')}`,
  tickets: (r) => plural(r.length, 'ticket'),
  ticketMessages: (r) => plural(r.length, 'message'),
  appeals: (r) => `${plural(r.length, 'appeal')} · latest ${r.at(-1).status}`,
  afk: (r) => `“${r[0].reason}” since ${day(r[0].since)}`,
  birthdays: (r) =>
    `${r[0].day} ${MONTHS[r[0].month - 1] ?? `month ${r[0].month}`}${r[0].year ? ` ${r[0].year}` : ''}`,
  giveawayEntries: (r) => plural(r.length, 'entry', 'entries'),
  inviteCounts: (r) => `${r[0].regular} regular · ${r[0].bonus} bonus · ${r[0].leaves} left`,
  inviteJoins: (r) => (r[0].inviter_id ? `invited by <@${r[0].inviter_id}>` : `joined via ${r[0].source}`),
  invitedOthers: (r) => plural(r.length, 'member'),
  invitePersonal: (r) => `code \`${r[0].code}\``,
  countingLast: () => 'you are the last counter',
};

export const data = new SlashCommandBuilder()
  .setName('mydata')
  .setDescription('Get a copy of the data Sylo has stored about you in this server.');

/** @param {import('discord.js').ChatInputCommandInteraction} interaction */
export async function execute(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: 'Run this in the server whose data you want a copy of.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const key = `${interaction.guildId}:${interaction.user.id}`;
  const now = Date.now();
  const prev = lastRun.get(key);
  if (prev && now - prev < COOLDOWN_MS) {
    const mins = Math.ceil((COOLDOWN_MS - (now - prev)) / 60_000);
    return interaction.reply({
      content: `You've exported your data here recently — try again in ${plural(mins, 'minute')}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const dump = exportUserData(interaction.guildId, interaction.user.id);
  const guildName = interaction.guild.name;

  if (dump.total === 0) {
    lastRun.set(key, now);
    return interaction.editReply({
      content: `Sylo has nothing stored about your account in **${guildName}**.`,
    });
  }

  // File: the complete copy, keyed by readable labels so it stands on its own.
  const fileData = {};
  const lines = [];
  for (const { key: src, label } of dump.summary) {
    const rows = dump.data[src];
    if (!rows.length) continue;
    fileData[label] = rows;
    const detail = render[src] ? render[src](rows) : plural(rows.length, 'row');
    lines.push(`**${label}** — ${detail}`);
  }
  const fileObj = {
    about:
      `Data Sylo stores about ${interaction.user.username} in "${guildName}" as of ${dump.generatedAt}. ` +
      `Same scope as /forget. Does not include messages you posted in channels.`,
    server: guildName,
    guildId: dump.guildId,
    userId: dump.userId,
    generatedAt: dump.generatedAt,
    data: fileData,
  };
  const json = JSON.stringify(fileObj, null, 2);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_BYTES) {
    return interaction.editReply({
      content:
        `Your export is unusually large (${(bytes / 1e6).toFixed(1)} MB) and can't be delivered here. ` +
        `Contact the server's admins, who can export it from the dashboard.`,
    });
  }

  const fileName = `sylo-data-${interaction.guildId}-${interaction.user.id}.json`;
  const makeFile = () => new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: fileName });

  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) {
    shown.push(`…and ${lines.length - MAX_LINES} more — see the attached file`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5b7cfa)
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
    .setTitle(`Your data in ${guildName}`)
    .setDescription(
      `Everything Sylo keeps about you here, as of ${time(Math.floor(now / 1000), 'f')}. ` +
        `This is what \`/forget\` deletes — messages you posted in channels aren't included.`
    )
    .addFields({
      name: `${plural(dump.total, 'row')} · ${plural(lines.length, 'category', 'categories')}`,
      value: shown.join('\n'),
    })
    .setFooter({ text: 'The attached JSON is the complete, portable copy.' });

  lastRun.set(key, now);

  try {
    await interaction.user.send({ embeds: [embed], files: [makeFile()] });
    return interaction.editReply({ content: '📬 Sent to your DMs.' });
  } catch {
    return interaction.editReply({
      content: "I couldn't DM you — check your privacy settings. Here's your export:",
      embeds: [embed],
      files: [makeFile()],
    });
  }
}
